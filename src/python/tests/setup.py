"""Test setup for MCP Outlet Python implementation.

This module provides conditional mock setup that only activates when explicitly configured,
ensuring the original implementation is used when no mocks are specified.
"""

from unittest.mock import AsyncMock, MagicMock, Mock, patch

# Global mock state
_mcp_caller_mock = None
_mock_patcher = None
_is_mock_active = False


def setup_mcp_caller_mock():
    """Set up the McpCaller mock using unittest.mock.patch."""
    global _mcp_caller_mock, _mock_patcher, _is_mock_active

    # Only set up mock if not already active
    if _is_mock_active:
        return _mcp_caller_mock

    # Create mock instance
    _mcp_caller_mock = MagicMock()
    _mcp_caller_mock.connect = AsyncMock(return_value=None)
    _mcp_caller_mock.execute_mcp_call = AsyncMock()
    _mcp_caller_mock.close = AsyncMock(return_value=None)

    # Create the mock class that returns our mock instance
    mock_class = Mock(return_value=_mcp_caller_mock)

    # Patch the McpCaller class where it's used
    _mock_patcher = patch("app.handlers.rpc.McpCaller", mock_class)
    _mock_patcher.start()
    _is_mock_active = True

    return _mcp_caller_mock


def get_mcp_caller_mock():
    """Get the current McpCaller mock instance."""
    return _mcp_caller_mock


def activate_mock_if_needed(has_mocks: bool):
    """Conditionally activate mocking based on whether mocks are configured."""
    if has_mocks and not _is_mock_active:
        setup_mcp_caller_mock()
    elif not has_mocks and _is_mock_active:
        teardown_test_environment()


def reset_mocks():
    """Reset all mocks - mirrors JavaScript resetMocks function."""
    if _mcp_caller_mock and _is_mock_active:
        _mcp_caller_mock.reset_mock()
        _mcp_caller_mock.connect.reset_mock()
        _mcp_caller_mock.execute_mcp_call.reset_mock()
        _mcp_caller_mock.close.reset_mock()

        # Clear any configured behavior
        _mcp_caller_mock.execute_mcp_call.return_value = None
        _mcp_caller_mock.execute_mcp_call.side_effect = None


def setup_test_environment():
    """Set up the test environment - but don't activate mocks unless needed."""
    # Don't automatically activate mocks - they'll be activated if needed
    pass


def teardown_test_environment():
    """Clean up the test environment."""
    global _mock_patcher, _is_mock_active

    reset_mocks()

    if _mock_patcher:
        _mock_patcher.stop()
        _mock_patcher = None
        _is_mock_active = False


def get_event_loop():
    """Get or create event loop for async testing."""
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop


def mock_console():
    """Mock console functionality for testing."""
    return Mock()
