class LlmServiceError(Exception):
    status_code = 400

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.code = code

    def detail(self):
        return {"code": self.code, "message": str(self)} if self.code else str(self)


class NotFound(LlmServiceError):
    status_code = 404


class Forbidden(LlmServiceError):
    status_code = 403


class Conflict(LlmServiceError):
    status_code = 409


class Invalid(LlmServiceError):
    status_code = 422


class Unavailable(LlmServiceError):
    status_code = 503
