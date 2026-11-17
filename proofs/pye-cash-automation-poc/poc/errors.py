class ProviderUnavailableError(RuntimeError):
    pass


class ProviderTimeoutError(RuntimeError):
    pass


class AmbiguousCreationError(RuntimeError):
    """Provider may have created an invoice, but the response was lost."""


class InvalidProviderResponseError(RuntimeError):
    pass


class QrGenerationError(RuntimeError):
    pass


class TelegramDeliveryError(RuntimeError):
    pass
