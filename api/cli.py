from __future__ import annotations

import argparse
import json
import getpass
import re
import sys
from datetime import date
from collections.abc import Sequence
from pathlib import Path

import uvicorn
import psycopg

from api.identity import DuplicateIdentityError, IdentityStore
from api.operations import create_snapshot, doctor, migrate_data, restore_snapshot, verify_snapshot, readiness_checks
from api.settings import Settings


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m api.cli")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("create-admin", help="交互创建本地系统管理员")
    subcommands.add_parser("migrate", help="使用迁移账号显式迁移 PostgreSQL 结构")
    backup = subcommands.add_parser("backup", help="创建完整数据快照")
    backup.add_argument("--destination", type=Path)
    restore = subcommands.add_parser("restore", help="校验或恢复数据快照")
    restore.add_argument("snapshot", type=Path)
    restore.add_argument("--verify-only", action="store_true")
    restore.add_argument("--apply", action="store_true")
    restore.add_argument("--confirm")
    subcommands.add_parser("doctor", help="检查本地运行环境")
    history = subcommands.add_parser("procurement-history", help="管理员首次历史迁入；默认只预检")
    history.add_argument("source", type=Path)
    history.add_argument("--apply", action="store_true")
    history.add_argument("--actor-id")
    history.add_argument("--sha256")
    inventory = subcommands.add_parser("procurement-inventory", help="管理员导入完整库存报表；默认只预检")
    inventory.add_argument("source", type=Path)
    inventory.add_argument("--apply", action="store_true")
    inventory.add_argument("--actor-id")
    inventory.add_argument("--sha256")
    inventory.add_argument("--catalog-sha256")
    rd5 = subcommands.add_parser("procurement-rd5", help="管理员补齐研发五部原料并准备配方数据；默认只预检")
    rd5.add_argument("source", type=Path)
    rd5.add_argument("--apply", action="store_true")
    rd5.add_argument("--actor-id")
    rd5.add_argument("--sha256")
    rd5.add_argument("--state-sha256")
    rd5.add_argument("--effective-date", type=date.fromisoformat)
    rd5.add_argument("--export-dir", type=Path)
    rd5_current = subcommands.add_parser("procurement-rd5-current", help="应用已确认的 CF401B 现行方案及历史试算范围；默认只预检")
    rd5_current.add_argument("sha256")
    rd5_current.add_argument("--apply", action="store_true")
    rd5_current.add_argument("--actor-id")
    rd5_current.add_argument("--state-sha256")
    rd5_current.add_argument("--export-dir", type=Path)
    serve = subcommands.add_parser("serve", help="启动正式单机服务")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=8000, type=int)
    serve.add_argument("--dist", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "serve":
            repository_root = Path(__file__).resolve().parent.parent
            static_dir = (args.dist or repository_root / "dist").resolve()
            if not (static_dir / "index.html").is_file():
                raise FileNotFoundError("前端构建产物不存在，请先运行 npm run build")
            if not 1 <= args.port <= 65535:
                raise ValueError("端口必须在 1 到 65535 之间")
            if args.host not in {"127.0.0.1", "localhost", "::1"}:
                print("警告：服务将对外监听，请先配置 HTTPS 与 Windows 防火墙。")
            from api.main import API_VERSION, create_app, create_unready_app

            try:
                runtime_settings = settings or Settings.from_environment()
            except (OSError, RuntimeError, ValueError) as error:
                print(f"运行配置无效，服务将以不可用状态启动：{error}", file=sys.stderr)
                application = create_unready_app(static_dir)
                environment_label = "配置异常"
                data_label = "不可用"
                enabled = "无"
            else:
                application = create_app(runtime_settings, static_dir=static_dir)
                environment_label = "测试环境" if runtime_settings.environment == "test" else "正式环境"
                data_label = runtime_settings.data_dir.name
                enabled = ", ".join(
                    module_id
                    for module_id, mode in runtime_settings.module_modes.items()
                    if mode != "off"
                ) or "无"
            print(f"宏昊 AI {API_VERSION} · {environment_label} · 数据目录 {data_label}")
            print(f"监听 http://{args.host}:{args.port} · 运行模块 {enabled}")
            uvicorn.run(
                application,
                host=args.host,
                port=args.port,
                log_level="info",
            )
            return 0

        runtime_settings = settings or Settings.from_environment()
        if args.command == "procurement-rd5-current":
            from api.procurement_rd5 import revise_preparation, export_preparation
            if args.apply and not all((args.actor_id, args.state_sha256)):
                raise ValueError("执行修订须提供管理员ID及预检状态SHA256")
            result = revise_preparation(runtime_settings.database_url, args.sha256,
                actor_id=args.actor_id if args.apply else None, expected_state_sha256=args.state_sha256)
            if args.export_dir:
                result["export"] = export_preparation(runtime_settings.database_url, args.sha256, args.export_dir)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "procurement-rd5":
            from api.procurement_rd5 import preview, import_rd5, export_preparation
            result = preview(runtime_settings.database_url, args.source.read_bytes())
            if args.apply:
                if not all((args.actor_id, args.sha256, args.state_sha256, args.effective_date)):
                    raise ValueError("执行导入须提供管理员ID、预检文件及状态SHA256、价格生效日期")
                result = import_rd5(runtime_settings.database_url, args.source, args.actor_id,
                                    data_dir=runtime_settings.data_dir, expected_sha256=args.sha256, expected_state_sha256=args.state_sha256,
                                    effective_date=args.effective_date)
            if args.export_dir:
                result["export"] = export_preparation(runtime_settings.database_url, result["sha256"], args.export_dir)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "procurement-inventory":
            from api.procurement_inventory import inventory_preview, import_inventory
            result = inventory_preview(runtime_settings.database_url, args.source.read_bytes())
            if args.apply:
                if not args.actor_id or not args.sha256 or not args.catalog_sha256:
                    raise ValueError("执行导入须提供有效管理员ID、预检文件SHA256及目录SHA256")
                result = import_inventory(runtime_settings.database_url, args.source, args.actor_id,
                                          data_dir=runtime_settings.data_dir, expected_sha256=args.sha256, expected_catalog_sha256=args.catalog_sha256)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "procurement-history":
            from api.procurement_excel import history_preview, import_history
            result = history_preview(args.source.read_bytes())
            if args.apply:
                if not args.actor_id or not args.sha256:
                    raise ValueError("执行迁入须提供有效管理员ID及预检SHA256")
                result = import_history(runtime_settings.database_url, args.source, args.actor_id, data_dir=runtime_settings.data_dir, expected_sha256=args.sha256)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "migrate":
            versions = migrate_data(runtime_settings)
            print("迁移完成：" + ", ".join(f"{key}={value}" for key, value in versions.items()))
            return 0
        if args.command == "backup":
            destination = args.destination or runtime_settings.data_dir / "backups"
            print(create_snapshot(runtime_settings, destination))
            return 0
        if args.command == "restore":
            verify_snapshot(args.snapshot, expected_environment=runtime_settings.environment, expected_database_environment=runtime_settings.database_environment)
            if not args.apply:
                print("快照校验通过，未写入数据。")
                return 0
            if args.verify_only:
                print("--verify-only 不能与 --apply 同时使用。", file=sys.stderr)
                return 1
            if args.confirm != "RESTORE":
                print("恢复已阻止：写入时必须提供 --confirm RESTORE。", file=sys.stderr)
                return 1
            restore_snapshot(runtime_settings, args.snapshot)
            print("恢复完成：已核验数据库及附件，原快照保持不变。")
            return 0
        if args.command == "doctor":
            checks = doctor(runtime_settings)
            for name, detail, passed in checks:
                status = "OK" if passed is True else "WARN" if passed is None else "FAIL"
                print(f"[{status}] {name}：{detail}")
            return 0 if all(passed is not False for _, _, passed in checks) else 1
        if args.command == "create-admin" and any(value != "ok" for value in readiness_checks(runtime_settings).values()):
            raise RuntimeError("应用数据库未就绪；请先完成迁移，再使用应用账号创建管理员")
    except psycopg.Error:
        print("操作失败：数据库连接、权限或操作异常，未输出连接凭据。", file=sys.stderr)
        return 1
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
    identities = IdentityStore(runtime_settings.database_url)
    try:
        identities.create_user(
            username=username,
            display_name=display_name,
            department=department,
            password=password,
            is_system_admin=True,
        )
    except psycopg.Error:
        print("管理员创建失败：请检查数据库连接及权限。", file=sys.stderr)
        return 1
    except DuplicateIdentityError:
        print("该用户名已存在。", file=sys.stderr)
        return 1

    print(f"已创建系统管理员：{username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
