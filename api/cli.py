from __future__ import annotations

import argparse
import getpass
import re
import sys
from collections.abc import Sequence

from api.database import Database
from api.identity import DuplicateIdentityError, IdentityStore, SYSTEM_ADMIN_ROLE_ID
from api.settings import Settings


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.cli")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("create-admin", help="交互创建本地系统管理员")
    args = parser.parse_args(argv)

    if args.command != "create-admin":
        return 2

    runtime_settings = settings or Settings.from_environment()
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
    Database(runtime_settings.database_path).initialize()
    identities = IdentityStore(runtime_settings.database_path)
    identities.initialize()
    try:
        identities.create_user(
            username=username,
            display_name=display_name,
            department=department,
            password=password,
            role_ids=[SYSTEM_ADMIN_ROLE_ID],
        )
    except DuplicateIdentityError:
        print("该用户名已存在。", file=sys.stderr)
        return 1

    print(f"已创建系统管理员：{username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
