"""Shared `python -m fakes.<service>` entry point."""

from __future__ import annotations

import argparse
from collections.abc import Sequence

import uvicorn
from fastapi import FastAPI


def serve(app: FastAPI, name: str, default_port: int, argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog=f"python -m fakes.{name}", description=app.description)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=default_port)
    args = parser.parse_args(argv)
    uvicorn.run(app, host=args.host, port=args.port)
