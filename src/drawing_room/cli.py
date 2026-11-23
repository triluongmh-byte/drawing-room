"""Command line: ``drawing-room serve [--lan] [--pin] [--port 8430] [--data DIR]``."""

from __future__ import annotations

import argparse
import os

from drawing_room.projects import DEFAULT_DATA
from drawing_room.server import DEFAULT_PORT, serve


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="drawing-room", description="Sketchbook Club: a local sketchbook for drawing by hand, with Claude as the teacher.")
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("serve", help="start the web app")
    run.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to listen on (default {DEFAULT_PORT})")
    run.add_argument("--lan", action="store_true",
                     help="listen on every interface so a tablet on your Wi-Fi can connect (local network only)")
    run.add_argument("--pin", action="store_true", help="also ask for a 6-digit PIN printed at start-up")
    run.add_argument("--data", default=os.environ.get("DRAWING_ROOM_DATA") or str(DEFAULT_DATA),
                     help=f"where projects are kept (default {DEFAULT_DATA}, or $DRAWING_ROOM_DATA)")
    args = parser.parse_args(argv)
    if args.command == "serve":
        serve(args.port, args.lan, pin=args.pin, data=args.data)


if __name__ == "__main__":
    main()
