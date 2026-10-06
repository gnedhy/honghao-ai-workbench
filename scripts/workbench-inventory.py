"""Read literal backend registration without importing business code or connecting to a DB."""
import ast
import json
from pathlib import Path


def constants(path):
    values = {}
    for node in ast.parse(Path(path).read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            values[node.targets[0].id] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            values[node.target.id] = node.value
    return values


def sequence(node, values):
    if isinstance(node, ast.Name):
        return sequence(values[node.id], values)
    if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice):
        part = node.slice
        return sequence(node.value, values)[slice(
            ast.literal_eval(part.lower) if part.lower else None,
            ast.literal_eval(part.upper) if part.upper else None,
            ast.literal_eval(part.step) if part.step else None,
        )]
    result = ast.literal_eval(node)
    assert isinstance(result, (tuple, list)) and all(isinstance(item, str) for item in result)
    return list(result)


if __name__ == "__main__":
    workbenches = constants("api/workbenches.py")
    modules = constants("api/modules.py")
    authorization = constants("api/authorization.py")
    alias = workbenches["WorkbenchId"]
    assert isinstance(alias, ast.Subscript) and isinstance(alias.value, ast.Name) and alias.value.id == "Literal"
    wrappers = {}
    for path in Path('tests').glob('test_*.py'):
        for node in ast.parse(path.read_text(encoding='utf-8')).body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test_'):
                for value in ast.walk(node):
                    if isinstance(value, ast.Constant) and isinstance(value.value, str) and value.value.startswith('scripts/check-') and value.value.endswith('.mjs'):
                        wrappers.setdefault(value.value, []).append(path.as_posix() + '::' + node.name)
    print(json.dumps({
        "modules": sequence(modules["MODULE_IDS"], modules),
        "workbenches": sequence(workbenches["WORKBENCH_IDS"], workbenches),
        "typeIds": sequence(alias.slice, workbenches),
        "scopes": sequence(authorization["WORKBENCH_SCOPE_IDS"], authorization),
        "browserWrappers": wrappers,
    }))
