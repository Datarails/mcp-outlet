import json
import os
import importlib
import tempfile
import tarfile
import zipfile
import shutil
from pathlib import Path
from pydantic import BaseModel
from typing import Any, Dict, Union, List


class HandlerInput(BaseModel):
    """Handler input structure that mirrors TypeScript HandlerInput<T>."""

    data: Dict[str, Any]
    headers: Dict[str, str] = {}
    path_params: Dict[str, str] = {}
    query_params: Dict[str, str] = {}


def add_to_path(directory: str):
    """Add directory to PATH environment variable."""
    current_path = os.environ.get("PATH", "")
    if directory not in current_path:
        os.environ["PATH"] = f"{directory}:{current_path}"


def add_layer_to_path(layer: Dict[str, Any]) -> str:
    """
    Extract layer to temporary directory and add to PATH.
    Mirrors TypeScript addLayerToPath functionality.
    """
    tmp_dir = os.environ.get("TEMP_FOLDER", tempfile.gettempdir())

    # Compute where we want to extract (strip the extension for the folder name)
    layer_name = layer.get("name", "")
    layer_base = Path(
        layer_name
    ).stem  # Remove extension, equivalent to parse(layer.name).name
    layer_dir = os.path.join(tmp_dir, "layers", layer_base)

    if not os.path.exists(layer_dir):
        # Remove existing directory if it exists
        if os.path.exists(layer_dir):
            shutil.rmtree(layer_dir)

        # Create directory structure
        os.makedirs(layer_dir, exist_ok=True)

        # Extract the layer file
        layer_file_path = os.path.join(".", layer_name)

        try:
            # Try tar extraction first (most common for layers)
            if layer_name.endswith((".tar.gz", ".tgz", ".tar")):
                with tarfile.open(layer_file_path, "r:*") as tar:
                    # Extract with strip=1 equivalent (remove first path component)
                    members = tar.getmembers()
                    for member in members:
                        # Skip the first path component (equivalent to strip=1)
                        path_parts = member.name.split("/")
                        if len(path_parts) > 1:
                            member.name = "/".join(path_parts[1:])
                            if member.name:  # Only extract if there's a path left
                                tar.extract(member, layer_dir)

            # Try zip extraction
            elif layer_name.endswith(".zip"):
                with zipfile.ZipFile(layer_file_path, "r") as zip_file:
                    for member in zip_file.namelist():
                        # Skip the first path component (equivalent to strip=1)
                        path_parts = member.split("/")
                        if len(path_parts) > 1:
                            new_path = "/".join(path_parts[1:])
                            if new_path:  # Only extract if there's a path left
                                # Extract to new path
                                source = zip_file.open(member)
                                target_path = os.path.join(layer_dir, new_path)
                                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                                with open(target_path, "wb") as target:
                                    shutil.copyfileobj(source, target)
                                source.close()

            else:
                # Fallback: just copy the file
                shutil.copy2(layer_file_path, layer_dir)

        except Exception as e:
            pass
            # Continue anyway, directory might still be useful

    add_to_path(layer_dir)
    return layer_dir


def safe_json_parse(json_string: Union[str, Dict[str, Any], None]) -> Dict[str, Any]:
    """Safe JSON parser helper."""
    if not json_string:
        return {}

    # Handle different Azure Function body formats
    if isinstance(json_string, dict):
        return json_string

    try:
        return json.loads(json_string)
    except (json.JSONDecodeError, TypeError) as error:
        return {}


def extract_unified_params(req) -> Dict[str, Any]:
    """Extract and combine all parameters from Azure Function event."""
    raw_body = req.get_body()
    body = req.get_body().decode() if req.get_body() else ""
    query_params = dict(req.params)  # req.params is for query parameters
    body_params = safe_json_parse(raw_body or body)
    route_params = dict(req.route_params)  # req.route_params is for route parameters

    # Merge all parameters with body taking lowest precedence
    # Order: routeParams override queryParams override bodyParams
    return HandlerInput(
        data=body_params,
        headers=req.headers,
        path_params=route_params,
        query_params=query_params,
    )


def handler_azure_function_wrapper(
    handler_path: str, layers: List[Dict[str, Any]] = []
):
    """Azure Function wrapper that calls shiv executable instead of importing module."""

    async def main(req, res):
        """Azure Function entry point."""
        import azure.functions as func

        for layer in layers:
            add_layer_to_path(layer)

        handler_module = importlib.import_module(f"app.handlers.{handler_path}")
        handler_class = getattr(handler_module, handler_path)
        try:
            # Extract and unify all parameters
            unified_params = extract_unified_params(req)

            # Create Azure Function compatible context
            azure_context = {
                "invocationId": req.headers.get("x-ms-request-id", "unknown"),
                "functionName": "mcpOutlet",
                "logGroupName": "/azure/functions/mcpOutlet",
                "logStreamName": req.headers.get("x-ms-request-id", "unknown"),
                "memoryLimitInMB": os.environ.get("FUNCTIONS_MEMORY_SIZE", "128"),
                "callbackWaitsForEmptyEventLoop": False,
            }

            # Execute the Python handler using await for async execution
            result = await handler_class.execute(unified_params, azure_context)

            # Convert result to Azure Function response and set on res binding
            if result and isinstance(result, dict):
                if "success" in result:
                    if result["success"]:
                        response = func.HttpResponse(
                            body=json.dumps(result.get("data", {})),
                            status_code=result.get("statusCode", 200),
                            headers={
                                "Content-Type": "application/json",
                                **result.get("headers", {}),
                                "Access-Control-Allow-Origin": "*",
                                "Access-Control-Allow-Credentials": "true",
                            },
                            mimetype="application/json",
                        )
                    else:
                        response = func.HttpResponse(
                            body=json.dumps({"error": result.get("error", {})}),
                            status_code=500,
                            headers={"Content-Type": "application/json"},
                            mimetype="application/json",
                        )
                else:
                    response = func.HttpResponse(
                        body=json.dumps(result),
                        status_code=200,
                        headers={
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Credentials": "true",
                        },
                        mimetype="application/json",
                    )
            else:
                response = func.HttpResponse(
                    body=json.dumps(result if result is not None else {}),
                    status_code=200,
                    headers={
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Credentials": "true",
                    },
                    mimetype="application/json",
                )

            # Set the response on the output binding
            res.set(response)

        except Exception as error:
            error_response = func.HttpResponse(
                body=json.dumps({"error": {"message": str(error)}}),
                status_code=500,
                headers={"Content-Type": "application/json"},
                mimetype="application/json",
            )
            res.set(error_response)

    return main


# Export the wrapper function
__all__ = ["handler_azure_function_wrapper"]
