from __future__ import annotations

import argparse
import getpass
import re
import sys
from collections.abc import Sequence
from pathlib import Path

from api.identity import DuplicateIdentityError, IdentityStore
from api.operations import create_snapshot, doctor, migrate_data, restore_snapshot, verify_snapshot
from api.settings import Settings


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.cli")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("create-admin", help="交互创建本地系统管理员")
    subcommands.add_parser("migrate", help="初始化或升级当前数据目录")
    backup = subcommands.add_parser("backup", help="创建完整数据快照")
    backup.add_argument("--destination", type=Path)
    restore = subcommands.add_parser("restore", help="校验或恢复数据快照")
    restore.add_argument("snapshot", type=Path)
    restore.add_argument("--verify-only", action="store_true")
    restore.add_argument("--apply", action="store_true")
    restore.add_argument("--confirm")
    subcommands.add_parser("doctor", help="检查本地运行环境")
    args = parser.parse_args(argv)
    try:
        runtime_settings = settings or Settings.from_environment()
        if args.command == "migrate":
            versions = migrate_data(runtime_settings)
            print("迁移完成：" + ", ".join(f"{key}={value}" for key, value in versions.items()))
            return 0
        if args.command == "backup":
            destination = args.destination or runtime_settings.data_dir / "backups"
            print(create_snapshot(runtime_settings, destination))
            return 0
        if args.command == "restore":
            verify_snapshot(args.snapshot, expected_environment=runtime_settings.environment)
            if not args.apply:
                print("快照校验通过，未写入数据。")
                return 0
            if args.verify_only:
                print("--verify-only 不能与 --apply 同时使用。", file=sys.stderr)
                return 1
            if args.confirm != "RESTORE":
                print("恢复已阻止：写入时必须提供 --confirm RESTORE。", file=sys.stderr)
                return 1
            rollback = restore_snapshot(runtime_settings, args.snapshot)
            detail = f"，写入前快照：{rollback}" if rollback else ""
            print(f"恢复完成{detail}")
            return 0
        if args.command == "doctor":
            checks = doctor(runtime_settings)
            for name, detail, passed in checks:
                print(f"[{'OK' if passed else 'FAIL'}] {name}：{detail}")
            return 0 if all(passed for _, _, passed in checks) else 1
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as error:
        print(f"操作失败：{error}", file=sys.stderr)
        return 1

    username = input("用户名：").strip()
    display_name = input("姓名：").strip()
    department = input("部门（可留空）：").strip() or None
    password = getpass.getpass("密码（至少 12 位）：")
    confirmation = getpass.getpass("再次输入密码：")
    valid_username = bool(re.fullmatch(r"[A-Za-z0-9._-]{1,100}", username))
    if (
        not valid_username
        or not 1 <= len(display_name) <= 100
        or department is not None and len(department) > 100
        or not 12 <= len(password) <= 1_000
        or password != confirmation
    ):
        print("管理员信息无效或两次密码不一致。", file=sys.stderr)
        return 1

    runtime_settings.ensure_directories()
    migrate_data(runtime_settings)
    identities = IdentityStore(runtime_settings.database_path)
    identities.initialize()
    try:
        identities.create_user(
            username=username,
            display_name=display_name,
            department=department,
            password=password,
            is_system_admin=True,
        )
    except DuplicateIdentityError:
        print("该用户名已存在。", file=sys.stderr)
        return 1

    print(f"已创建系统管理员：{username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
