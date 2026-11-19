"""Saving and loading transcripts, and the `view` command that serves them to the browser viewer.
The replay itself is tested on the Node side (js/test/recorder.test.js, js/test/viewer.test.js) and in a real
browser by bench/viewer_check.js."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request

import numpy as np
import pytest

from bota_harness import (ACTION_NVEC, BotaEnv, HarnessError, ScenarioTask, TestRoom, load_scenario, load_transcript,
                          save_transcript)
from bota_harness.replay import verify


def _finished_transcripts(make_env, n_envs=3, want=3):
    env = make_env(n_envs, ScenarioTask(TestRoom(enemies=("bug",), max_play_frames=600)), workers=1, record=True)
    env.reset(seed=4)
    rng = np.random.default_rng(1)
    out = []
    while len(out) < want:
        _, _, _, _, info = env.step(rng.integers(0, ACTION_NVEC, size=(n_envs, 4)))
        if "_result" in info:
            for i in np.flatnonzero(info["_result"]):          # NumPy integers as indices
                out.append((i, env.transcript(i), info["result"][i]))
    return env, out[:want]   # one step can end several episodes


def test_save_names_files_after_the_episode_and_round_trips(make_env, tmp_path):
    env, done = _finished_transcripts(make_env)
    i, t, res = done[0]
    assert t["scenario"]["seed"] == res.seed and t["result"]["reason"] == res.reason
    folder = tmp_path / "recordings"                      # does not exist yet
    p1 = save_transcript(t, f"{folder}/")
    p2 = save_transcript(t, folder)                       # an existing folder, same second: numbered
    assert p1.parent == folder and p1.name.startswith(f"test_room-{res.seed}-{res.reason}-") and p1.suffix == ".json"
    assert p2 != p1 and p2.stem.endswith("-2")
    assert load_transcript(p1) == t
    assert not list(folder.glob(".*.tmp")), "no temporary files left behind"
    named = save_transcript(t, tmp_path / "deep" / "er" / "chosen.json")
    assert named == tmp_path / "deep" / "er" / "chosen.json" and json.loads(named.read_text()) == t
    assert verify(p1)["ok"], "a saved transcript replays to its recorded end"


def test_env_save_transcript_in_the_step_that_ended_the_episode(make_env, tmp_path):
    env = make_env(2, ScenarioTask(load_scenario("single_bug")), workers=1, record=True)
    env.reset(seed=8)
    rng = np.random.default_rng(2)
    saved = []
    while not saved:
        _, _, _, _, info = env.step(rng.integers(0, ACTION_NVEC, size=(2, 4)))
        if "_result" in info:
            saved = [(env.save_transcript(i, tmp_path), info["result"][i]) for i in np.flatnonzero(info["_result"])]
    for path, res in saved:
        t = load_transcript(path)
        assert t["result"]["reason"] == res.reason and t["result"]["decisions"] == res.decisions
        assert verify(path)["ok"]


def test_single_env_save(tmp_path):
    env = BotaEnv(ScenarioTask(TestRoom(enemies=("bug",), max_play_frames=200)), record=True)
    try:
        env.reset(seed=1)
        done = False
        while not done:
            _, _, term, trunc, _ = env.step(env.action_space.sample())
            done = term or trunc
        path = env.save_transcript(tmp_path / "one.json")
        assert load_transcript(path)["result"]["playFrames"] == 200
    finally:
        env.close()


def test_bad_input_is_refused(tmp_path):
    with pytest.raises(HarnessError, match="not a transcript"):
        save_transcript({"hello": 1}, tmp_path / "x.json")
    (tmp_path / "y.json").write_text(json.dumps({"format": 99}))
    with pytest.raises(HarnessError, match="does not hold a transcript"):
        load_transcript(tmp_path / "y.json")


def test_view_command_serves_saved_recordings(make_env, tmp_path):
    env, done = _finished_transcripts(make_env, want=2)
    for _, t, _ in done:
        save_transcript(t, f"{tmp_path}/")
    proc = subprocess.Popen([sys.executable, "-m", "bota_harness.cli", "view", str(tmp_path), "--port", "0"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        url, t0 = None, time.time()
        while url is None and time.time() - t0 < 30:
            line = proc.stdout.readline()
            if not line:
                break
            if line.startswith("Replay viewer: "):
                url = line.split(": ", 1)[1].strip()
        assert url and url.startswith("http://127.0.0.1:"), "prints its address"
        info = json.loads(urllib.request.urlopen(url + "api/info", timeout=10).read())
        assert len(info["transcripts"]) == 2
        assert {x["seed"] for x in info["transcripts"]} == {t["scenario"]["seed"] for _, t, _ in done}
        page = urllib.request.urlopen(url, timeout=10).read().decode()
        assert "/viewer/viewer.js" in page and "/game/src/game.js" in page
    finally:
        proc.terminate()
        proc.wait(timeout=10)
