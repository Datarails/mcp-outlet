"""Dynamic test suite for MCP Outlet Python implementation.

This module dynamically generates pytest tests from the test configuration,
mirroring the JavaScript dynamic test implementation.
"""

import json
import os
import pytest
import sys
from pathlib import Path
from typing import Any, Dict

# Absolute imports from python package
from app.helpers.tracer import Tracer
from app.handlers.rpc import rpc
from app.handlers.helpers import HandlerInput
from tests.setup import (
    activate_mock_if_needed,
    get_mcp_caller_mock,
    reset_mocks,
    setup_test_environment,
    teardown_test_environment,
)


class DynamicTestRunner:
    """Dynamic test runner that loads test configuration and creates pytest tests."""

    def __init__(self):
        self.test_config = self._load_test_config()
        self.original_env = dict(os.environ)

    def _load_test_config(self) -> Dict[str, Any]:
        """Load test configuration from the environment-specified path."""
        config_path = os.environ.get("TEST_CONFIG_PATH")
        if not config_path:
            raise EnvironmentError("TEST_CONFIG_PATH environment variable must be set")

        # Resolve path from current working directory
        # If we're in src/python, we need to go up two levels to find test/config.json
        # Try the direct path first, then try from project root
        possible_paths = [
            Path.cwd() / config_path,  # Direct path from current directory
            Path(__file__).parent.parent.parent.parent
            / config_path,  # From project root
        ]

        for full_path in possible_paths:
            if full_path.exists():
                with open(full_path, "r", encoding="utf-8") as f:
                    return json.load(f)

        raise FileNotFoundError(
            f"Could not find test config file at any of: {possible_paths}"
        )

    async def execute_test(self, input_data: Any) -> Any:
        """Execute a test case."""
        tracer = Tracer("test-trace")
        handler_input = HandlerInput(
            data=input_data["data"], headers={}, path_params={}, query_params={}
        )
        return await rpc.execute(handler_input, {"tracer": tracer})

    def to_matcher(self, value: Any) -> Any:
        """Convert placeholder symbols into Python equivalents of Jest matchers."""
        if isinstance(value, dict):
            kind = value.get("__kind")
            if kind == "ANY_STRING":
                return str
            elif kind == "ANY_NUMBER":
                return (int, float)
            elif kind == "ANY_DATE":
                return "ANY_DATE"
            elif kind == "ANY_OBJECT":
                return dict
            elif kind == "ANYTHING":
                return "ANYTHING"
            elif kind == "STRING_CONTAINING":
                return {"__contains": value.get("substring")}
            elif kind == "OBJECT_CONTAINING":
                return {"__contains_obj": self.to_matcher(value.get("partial"))}
            elif kind == "NOT_OBJECT_CONTAINING":
                return {"__not_contains_obj": self.to_matcher(value.get("partial"))}
            else:
                return {k: self.to_matcher(v) for k, v in value.items()}
        elif isinstance(value, list):
            return [self.to_matcher(item) for item in value]
        else:
            return value

    def assert_matches(self, actual: Any, expected: Any) -> None:
        """Assert that actual matches expected, handling special matchers."""
        if expected == "ANYTHING":
            return
        elif expected == "ANY_DATE":
            # ANY_DATE should match any string that looks like a date
            assert isinstance(actual, str), f"Expected date string, got {type(actual)}"
            # Basic check for ISO datetime format
            assert (
                "-" in actual and ":" in actual
            ), f"Expected date-like string, got {actual}"
            return
        elif isinstance(expected, tuple):
            # Handle tuple type matching (e.g., (int, float) for ANY_NUMBER)
            assert isinstance(
                actual, expected
            ), f"Expected one of {expected}, got {type(actual)}"
            return
        elif isinstance(expected, type):
            assert isinstance(
                actual, expected
            ), f"Expected {expected}, got {type(actual)}"
        elif isinstance(expected, dict):
            if "__contains" in expected:
                assert expected["__contains"] in str(
                    actual
                ), f"Expected '{expected['__contains']}' in '{actual}'"
                return
            elif "__contains_obj" in expected:
                if isinstance(actual, dict):
                    self._assert_object_contains(actual, expected["__contains_obj"])
                return
            elif "__not_contains_obj" in expected:
                if isinstance(actual, dict):
                    self._assert_object_not_contains(
                        actual, expected["__not_contains_obj"]
                    )
                return
            else:
                assert isinstance(actual, dict), f"Expected dict, got {type(actual)}"
                for key, exp_value in expected.items():
                    assert key in actual, f"Key '{key}' not found in actual result"
                    self.assert_matches(actual[key], exp_value)
        elif isinstance(expected, list):
            assert isinstance(actual, list), f"Expected list, got {type(actual)}"
            assert len(actual) == len(
                expected
            ), f"Expected list length {len(expected)}, got {len(actual)}"
            for i, (act_item, exp_item) in enumerate(zip(actual, expected)):
                self.assert_matches(act_item, exp_item)
        else:
            assert actual == expected, f"Expected {expected}, got {actual}"

    def _assert_object_contains(
        self, actual: Dict[str, Any], expected: Dict[str, Any]
    ) -> None:
        """Assert that actual object contains all keys and values from expected."""
        for key, exp_value in expected.items():
            assert key in actual, f"Key '{key}' not found in actual object"
            self.assert_matches(actual[key], exp_value)

    def _assert_object_not_contains(
        self, actual: Dict[str, Any], expected: Dict[str, Any]
    ) -> None:
        """Assert that actual object does NOT contain the expected structure."""
        try:
            self._assert_object_contains(actual, expected)
            assert False, "Object should not contain the expected structure"
        except AssertionError:
            pass

    def setup_mocks_for_test(self, test_mocks: Dict[str, Any] = None) -> None:
        """Setup mocks for a test case."""
        merged_mocks = {**(self.test_config.get("mocks", {})), **(test_mocks or {})}

        # Only activate mocking if there are actual mock configurations
        has_mocks = bool(merged_mocks)
        activate_mock_if_needed(has_mocks)

        if not has_mocks:
            return  # No mocks configured, use original implementation

        reset_mocks()

        # Get the actual mock instance
        mcp_mock = get_mcp_caller_mock()
        if not mcp_mock:
            return

        for method, behavior in merged_mocks.items():
            # Map executeMcpCall to execute_mcp_call for compatibility
            actual_method = "execute_mcp_call" if method == "executeMcpCall" else method
            mock_fn = getattr(mcp_mock, actual_method, None)

            if mock_fn:
                implementation = behavior.get("implementation")
                throws = behavior.get("throws")
                returns = behavior.get("returns")

                # Clear any previous configuration
                mock_fn.reset_mock()

                if implementation:
                    mock_fn.side_effect = implementation
                elif throws:
                    if isinstance(throws, dict) and "message" in throws:
                        mock_fn.side_effect = Exception(throws["message"])
                    else:
                        mock_fn.side_effect = Exception(str(throws))
                elif returns == "void":
                    mock_fn.return_value = None
                elif returns is not None:
                    mock_fn.return_value = returns
                    mock_fn.side_effect = (
                        None  # Clear side_effect if return_value is set
                    )

    def setup_env_for_test(self, test_env: Dict[str, str] = None) -> None:
        """Setup environment variables for a test."""
        # Only update original_env if not already set to avoid overwriting
        if not hasattr(self, "original_env") or self.original_env is None:
            self.original_env = dict(os.environ)

        merged_env = {**(self.test_config.get("env", {})), **(test_env or {})}

        for key, value in merged_env.items():
            os.environ[key] = str(value)

    def restore_env(self) -> None:
        """Restore original environment variables."""
        # Store current keys to avoid KeyError during cleanup
        current_keys = list(os.environ.keys())

        # Remove all current environment variables
        for key in current_keys:
            if key in os.environ:
                del os.environ[key]

        # Restore original environment variables
        os.environ.update(self.original_env)

    async def run_test_case(self, test_case: Dict[str, Any]) -> None:
        """Run a single test case."""
        self.setup_mocks_for_test(test_case.get("mocks"))
        self.setup_env_for_test(test_case.get("env"))

        try:
            result = await self.execute_test(test_case["input"])

            if "expected" in test_case:
                expected = self.to_matcher(test_case["expected"])
                self.assert_matches(result, expected)

        except Exception:
            raise


# Create global test runner instance
dynamic_runner = DynamicTestRunner()


def pytest_generate_tests(metafunc):
    """Generate pytest tests dynamically from test configuration."""
    if "test_case" in metafunc.fixturenames:
        test_cases = dynamic_runner.test_config.get("testCases", [])
        metafunc.parametrize("test_case", test_cases, ids=lambda tc: tc["name"])


@pytest.fixture(autouse=True)
def setup_and_teardown():
    """Set up and tear down for each test."""
    # Setup: Reset mocks and enable test mode
    setup_test_environment()
    reset_mocks()
    yield
    # Teardown: Only reset mocks and disable test mode (no env restoration)
    # Environment restoration is not needed since each test runs independently
    teardown_test_environment()


@pytest.mark.asyncio
async def test_dynamic_mcp_suite(test_case):
    """Main test function that runs each test case dynamically."""
    await dynamic_runner.run_test_case(test_case)


@pytest.fixture(scope="session", autouse=True)
def global_setup_teardown():
    """Global setup and teardown for the entire test session."""
    # Setup: Initialize test environment
    yield
    # Teardown: No environment restoration needed for pytest
