import subprocess
import json
from typing import Optional, List, Dict, Tuple
import os
import sys


def setup_uv_environment():
    env = os.environ.copy()
    cache_dir = env.get("CACHE_DIR", "/mnt/cache")

    # Create installation directory within cache
    import site

    # UV will install packages into cache_dir/lib/python{version}/site-packages
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    uv_install_dir = os.path.join(
        cache_dir, "lib", f"python{python_version}", "site-packages"
    )

    # Ensure the directory exists
    os.makedirs(uv_install_dir, exist_ok=True)

    # Add UV installation directory to current runtime
    if uv_install_dir not in sys.path:
        sys.path.insert(0, uv_install_dir)  # Insert at beginning for priority

    python_paths = []

    # Add UV installation directory first (highest priority)
    python_paths.append(uv_install_dir)

    # Add current site-packages (read-only)
    current_site_packages = site.getsitepackages()
    if isinstance(current_site_packages, list):
        python_paths.extend(current_site_packages)
    else:
        python_paths.append(current_site_packages)

    # Add user site-packages (read-only)
    user_site = site.getusersitepackages()
    if user_site:
        python_paths.append(user_site)

    # Add sys.path directories (current Python environment - read-only)
    python_paths.extend(sys.path)

    # Add existing PYTHONPATH if any
    existing_path = env.get("PYTHONPATH", "")
    if existing_path:
        python_paths.extend(existing_path.split(":"))

    # Remove duplicates and empty paths while preserving order
    seen = set()
    python_paths = [p for p in python_paths if p and p not in seen and not seen.add(p)]

    env.update(
        {
            "UV_CACHE_DIR": cache_dir,  # Set cache directory
            "UV_LINK_MODE": "copy",  # Use copy mode instead of hardlinks/symlinks
            "UV_NO_SYNC": "1",  # Don't sync lock file
            "UV_COMPILE_BYTECODE": "0",  # Don't compile bytecode
            "UV_NO_PROJECT": "1",  # Completely ignore project (.venv) for installation
            "UV_BREAK_SYSTEM_PACKAGES": "1",  # Allow installation without virtual env
            "PYTHONPATH": ":".join(
                python_paths
            ),  # UV packages first, then current packages (.venv included for reading)
        }
    )

    return env


def parse_mcp_server_params(args: List[str]) -> Dict[str, any]:
    """
    Parse uvx/uv/pip style arguments, execute uv add and uv inspect, return import info.

    Args:
        args: List of arguments like ['--from', 'git+https://...', 'package-name:entry', '--with', 'dep']

    Returns:
        Dict with module_path, function_name, and metadata
    """

    # Setup UV environment
    env = setup_uv_environment()

    # Get the installation directory from cache_dir
    cache_dir = env.get("UV_CACHE_DIR", ".mcp-outlet-cache")

    # Parse state
    package_name = None
    entry_point = None
    source_path = None
    with_deps = []
    index_url = None
    extra_index_urls = []

    i = 0
    while i < len(args):
        arg = args[i]

        if arg == "--from" and i + 1 < len(args):
            source_path = args[i + 1]
            i += 2
        elif arg == "--with" and i + 1 < len(args):
            with_deps.extend(args[i + 1].split(","))
            i += 2
        elif arg == "--index-url" and i + 1 < len(args):
            index_url = args[i + 1]
            i += 2
        elif arg == "--extra-index-url" and i + 1 < len(args):
            extra_index_urls.append(args[i + 1])
            i += 2
        elif arg.startswith("--"):
            # Skip unsupported options (--quiet, --verbose, etc.)
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                i += 2  # Skip option + value
            else:
                i += 1  # Skip option only
        elif not package_name:
            # First non-option argument is package name (possibly with entry point)
            if ":" in arg:
                package_name, entry_point = arg.split(":", 1)
            else:
                package_name = arg
            i += 1
        else:
            # Additional arguments (ignore for now)
            i += 1

    if not package_name:
        raise ValueError("No package name found in arguments")

    def _is_package_installed(pkg: str) -> bool:
        """Return True if *pkg* is already importable in the current environment."""
        try:
            import importlib.metadata as _importlib_metadata

            _importlib_metadata.version(pkg)
            return True
        except _importlib_metadata.PackageNotFoundError:
            pass
        except Exception:
            # Fallback to importlib.util.find_spec
            pass

        import importlib.util as _importlib_util

        return _importlib_util.find_spec(pkg.replace("-", "_")) is not None

    # ------------------------------------------------------------
    # Install main package if it is not already present
    # ------------------------------------------------------------

    if not _is_package_installed(package_name):
        uv_add_cmd = ["uv", "pip", "install", "--prefix", cache_dir]

        # Add index URLs
        if index_url:
            uv_add_cmd.extend(["--index-url", index_url])
        for extra_url in extra_index_urls:
            uv_add_cmd.extend(["--extra-index-url", extra_url])

        # Add source if specified
        if source_path:
            uv_add_cmd.append(source_path)
        else:
            # Add package name (without entry point)
            uv_add_cmd.append(package_name)

        # Execute uv install to cache directory only
        try:
            subprocess.run(
                uv_add_cmd,
                capture_output=True,
                text=True,
                timeout=120,
                check=True,
                env=env,
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"uv install failed: {e.stderr}")

    # ------------------------------------------------------------
    # Install any --with dependencies that are not yet installed
    # ------------------------------------------------------------
    for dep in with_deps:
        if _is_package_installed(dep):
            continue

        dep_cmd = ["uv", "pip", "install", "--prefix", cache_dir, dep]
        subprocess.run(
            dep_cmd,
            capture_output=True,
            text=True,
            timeout=500,
            check=True,
            env=env,
        )

    # ------------------------------------------------------------------
    # Step 2: Retrieve package metadata and entry points using Python's
    # `importlib.metadata`, avoiding costly subprocess calls.  Only if this
    # approach fails do we fall back to a single `uv pip show` subprocess
    # (much cheaper than the previous two-step show + inspect combo).
    # ------------------------------------------------------------------

    inspection_data: Dict[str, str] = {}
    entry_points: Dict = {}

    try:
        import importlib.metadata as _importlib_metadata

        # Basic metadata (name, version, etc.)
        meta = _importlib_metadata.metadata(package_name)
        inspection_data = {k.lower().replace("-", "_"): v for k, v in meta.items()}

        # Console-script entry points
        try:
            # entry_points() signature changed in 3.10 – supports selection by group
            eps = _importlib_metadata.entry_points()
            if hasattr(eps, "select"):
                eps = eps.select(group="console_scripts")
            else:
                eps = eps.get("console_scripts", [])  # type: ignore[attr-defined]

            entry_points = {
                ep.name: ep.value for ep in eps if ep.dist.name == package_name
            }
        except Exception:
            # Best-effort only – ignore on failure
            pass

    except Exception:
        # Fallback: run a single `uv pip show` (fast, <100 ms) to obtain
        # metadata if importlib could not find the distribution (rare but
        # possible when the package was just installed into the cache and
        # site-paths haven't updated correctly).
        try:
            show_cmd = ["uv", "pip", "show", package_name]
            result = subprocess.run(
                show_cmd,
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
                env=env,
            )
            inspection_data = parse_uv_show_output(result.stdout)
        except subprocess.CalledProcessError:
            # Still nothing; leave the dict empty and continue – the rest of
            # the logic can proceed without full metadata.
            inspection_data = {}

    # ------------------------------------------------------------------
    # End of metadata retrieval section (no additional subprocesses).
    # ------------------------------------------------------------------

    # Step 4: Try to get more detailed entry points
    entry_points = {}
    try:
        # Try uv pip inspect for more detailed info
        detailed_inspect_cmd = ["uv", "pip", "inspect", package_name]
        detailed_result = subprocess.run(
            detailed_inspect_cmd,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,  # Don't fail if inspect not available
            env=env,
        )
        if detailed_result.returncode == 0:
            try:
                detailed_data = json.loads(detailed_result.stdout)
                if "entry_points" in detailed_data:
                    entry_points = detailed_data["entry_points"]
            except json.JSONDecodeError:
                pass
    except Exception:
        pass

    # Step 5: Determine module path and function name
    module_path, function_name = resolve_entry_point(
        package_name, entry_point, entry_points, inspection_data
    )

    return {
        "package_name": package_name,
        "module_path": module_path,
        "function_name": function_name,
        "entry_point": entry_point,
        "source_path": source_path,
        "with_deps": with_deps,
        "inspection_data": inspection_data,
        "entry_points": entry_points,
        "install_success": True,
    }


def parse_uv_show_output(output: str) -> Dict[str, str]:
    """Parse uv pip show output into key-value pairs."""
    data = {}
    for line in output.split("\n"):
        if ":" in line:
            key, value = line.split(":", 1)
            data[key.strip().lower().replace("-", "_")] = value.strip()
    return data


def resolve_entry_point(
    package_name: str,
    requested_entry: Optional[str],
    entry_points: Dict,
    inspection_data: Dict,
) -> Tuple[str, str]:
    """
    Resolve the actual module path and function name to call.

    Priority:
    1. Explicit entry point from args (package:function)
    2. Console scripts from entry_points
    3. Default patterns
    """

    # Default fallbacks
    default_module = package_name.replace("-", "_")
    default_function = "main"

    # Case 1: Explicit entry point specified
    if requested_entry:
        if "." in requested_entry and ":" in requested_entry:
            # Full path like 'package.server:main'
            module_path, function_name = requested_entry.rsplit(":", 1)
            return module_path, function_name
        elif ":" in requested_entry:
            # Just function like ':server_main'
            module_path, function_name = requested_entry.split(":", 1)
            return default_module if not module_path else module_path, function_name
        else:
            # Just function name
            return default_module, requested_entry

    # Case 2: Look for console scripts in entry points
    console_scripts = entry_points.get("console_scripts", {})
    if console_scripts:
        # Try to find entry point that matches package name
        if package_name in console_scripts:
            entry_target = console_scripts[package_name]
            if ":" in entry_target:
                module_path, function_name = entry_target.rsplit(":", 1)
                return module_path, function_name

        # Use first console script as fallback
        for script_name, entry_target in console_scripts.items():
            if ":" in entry_target:
                module_path, function_name = entry_target.rsplit(":", 1)
                return module_path, function_name

    # Case 3: Try common patterns
    common_patterns = [
        f"{default_module}:main",
        f"{default_module}.main:main",
        f"{default_module}.cli:main",
        f"{default_module}.server:main",
        f"{default_module}.__main__:main",
    ]

    # For now, return the first pattern (could be enhanced to test imports)
    module_path, function_name = common_patterns[0].split(":")
    return module_path, function_name
