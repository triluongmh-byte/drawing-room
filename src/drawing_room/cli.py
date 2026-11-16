"""Command line: ``drawing-room serve [--lan] [--port 8430]``."""

from __future__ import annotations

import argparse

from drawing_room.server import DEFAULT_PORT, serve


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="drawing-room", description="A local practice room for drawing by hand.")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("serve", help="start the web app")
    run.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to listen on (default {DEFAULT_PORT})")
    run.add_argument("--lan", action="store_true",
                     help="listen on every interface so a tablet on your Wi-Fi can connect; prints a PIN")
    args = parser.parse_args(argv)
    if args.command == "serve":
        serve(args.port, args.lan)


if __name__ == "__main__":
    main()
