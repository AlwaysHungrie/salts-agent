class ToolFailure(Exception):
    """An expected failure returned to the client as {code, message}, never a stack trace."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
