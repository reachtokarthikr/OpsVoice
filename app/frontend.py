"""Local launcher for the OpsVoice browser client."""

from __future__ import annotations

import os

import uvicorn



def main() -> None:
    try:
        port = int(os.getenv("OPSVOICE_FRONTEND_PORT", "7860"))
    except ValueError:
        port = 7860

    uvicorn.run(
        "app.main:app",
        host=os.getenv("OPSVOICE_HOST", "127.0.0.1"),
        port=port,
        reload=os.getenv("OPSVOICE_RELOAD", "true").lower() == "true",
    )


if __name__ == "__main__":
    main()
