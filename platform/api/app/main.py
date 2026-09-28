from fastapi import FastAPI


def create_app(*, database_url: str = "sqlite://", verifier=None, idp=None) -> FastAPI:
    app = FastAPI(title="AI Platform API")

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    return app
