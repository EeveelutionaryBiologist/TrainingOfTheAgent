# Scenarios

One JSON file per scenario. The file name without `.json` is the scenario's name.

The format is the one `js/core/scenario.js` defines and validates (see the comment at its top), plus an optional
`description`. Leave `seed` out unless the scenario needs one particular floor: the environment then draws a
fresh seed for every episode.

```python
from bota_harness import BotaVecEnv, ScenarioTask, list_scenarios, load_scenario

list_scenarios()                                   # {"single_bug": "One Bug in an empty room ..."}
env = BotaVecEnv(16, ScenarioTask(load_scenario("single_bug")))
```

```
uv run bota-harness bench --scenario single_bug    # random policy on it
```

`load_scenario` also takes a path, so scenarios can live elsewhere. Every file in this folder is validated and
started once by the tests (`js/test/scenarios.test.js`, `tests/test_scenarios.py`).

| Scenario | What it sets up |
|---|---|
| `single_bug` | One Bug, empty room, floor 1; ends on room clear, death, or 60 s of play. |
