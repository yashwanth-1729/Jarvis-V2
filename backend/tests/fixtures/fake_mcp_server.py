"""A tiny stdio MCP server for connectors_test.py. Not a real integration.

Tools: ``echo`` (read-only) and ``write_note`` (changes things). Also prints a
non-JSON log line to stdout first, as real servers sometimes do.
"""

import json
import sys

print("fake server starting (a stray log line the client must skip)", flush=True)
TOOLS = [
    {"name": "echo", "description": "Echo text back.", "annotations": {"readOnlyHint": True},
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "write_note", "description": "Write a note.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}},
]

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue  # a notification
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        result = {"protocolVersion": params.get("protocolVersion"), "capabilities": {"tools": {}},
                  "serverInfo": {"name": "fake", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        args = params.get("arguments") or {}
        result = {"content": [{"type": "text", "text": f"{params['name']}: {args.get('text', '')}"}]}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"],
                          "error": {"code": -32601, "message": "no such method"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
