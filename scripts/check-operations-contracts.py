"""New implemented modules must carry executable operational checks."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('operations_monitor', Path(__file__).with_name('operations-monitor.py'))
monitor = importlib.util.module_from_spec(spec); spec.loader.exec_module(monitor)
policy = monitor.read_json(Path(__file__).with_name('operations-policy.json'))
workbenches = monitor.read_json(Path(__file__).with_name('workbench-contracts.json'))['workbenches']
monitor.validate_contract(policy, workbenches)
print('PASS operations profiles: every implemented workbench has supported checks and valid thresholds')
