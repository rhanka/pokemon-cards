class CardscopeMLError(Exception):
    """Base error for actionable pipeline failures."""


class DependencyUnavailableError(CardscopeMLError):
    """Raised when an explicitly optional dependency is needed."""


class ManifestError(CardscopeMLError, ValueError):
    """Raised when provenance or an operation policy is invalid."""


class DataIntegrityError(CardscopeMLError):
    """Raised when a declared asset is missing, unsafe, or has the wrong digest."""
