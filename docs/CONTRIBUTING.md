# Contributing to OpsVoice

## Workflow

1. Fork the repository.
2. Create a branch from `main`.
3. Keep changes consistent with the official Gemini Live Agent Challenge rules.
4. Prefer one architectural path per change. The current scaffold is a custom browser client plus FastAPI plus ADK.

## Development standards
- Python 3.11+
- Type hints on public functions
- Keep tool outputs explicit about whether data is live or scaffolded
- Do not introduce placeholder submission URLs as if they are final

## Key paths
- `app/main.py`: backend and WebSocket entrypoint
- `app/frontend.py`: local launcher
- `app/opsvoice_agent/agent.py`: agent definition and system prompt
- `app/opsvoice_agent/tools.py`: tool implementations
- `static/`: browser client
- `terraform/`: infrastructure scaffold

## Pull request checklist
- README matches the real repository state
- Setup steps were tested locally or the gap is called out
- New integrations document any external APIs or data sources
- Demo and submission templates are updated only when the underlying asset exists
