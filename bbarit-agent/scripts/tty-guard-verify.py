#!/usr/bin/env python3
"""tui.rs tty_guard 회귀 검증 (macOS/Linux 전용, pty + zsh 필요).

증상: 장시간 세션에서 스폰된 자식(또는 그 고아)이 tty foreground pgrp를
훔친 채 죽으면, 에이전트의 다음 tty read가 SIGTTIN으로 프로세스를 정지시키고
마우스 트래킹/alt screen이 켜진 채 셸로 떨어져 휠 스크롤마다 "65;91;14M"류
SGR 마우스 리포트가 프롬프트에 쏟아진다.

사용법:
  cargo build && python3 scripts/tty-guard-verify.py

Test A: zsh 잡으로 실행 중 SIGTSTP → 정지 전에 마우스/alt-screen 해제
        시퀀스가 tty로 나가고, 실제 stopped(T)이며, fg로 TUI 복귀.
Test B: 같은 세션의 백그라운드 도둑이 tcsetpgrp로 foreground를 훔치고 죽은 뒤
        입력이 와도 SIGTTIN 정지 없이 에이전트가 되찾아 계속 동작.

주의: 에이전트를 직접 스폰(start_new_session)하면 orphaned pgrp가 되어
POSIX가 stop 시그널을 폐기한다 — 반드시 zsh 세션 하에서 돌려야 재현된다.
"""
import os, pty, sys, time, signal, subprocess, select, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT = os.path.join(REPO, "target", "debug", "bbarit")
RESTORE_MARKS = [b"\x1b[?1006l", b"\x1b[?1003l", b"\x1b[?1049l"]

THIEF_SRC = """
import os, time, signal, ctypes
# 백그라운드 잡(자기 pgrp)으로 5초 대기 후 tty foreground를 훔치고 즉사 —
# "자식이 tty를 훔친 채 죽는" 실사용 시나리오 재현.
time.sleep(5)
libc = ctypes.CDLL(None)
signal.signal(signal.SIGTTOU, signal.SIG_IGN)
fd = os.open("/dev/tty", os.O_RDWR)
libc.tcsetpgrp(fd, os.getpgrp())
"""

def drain(fd, seconds):
    buf = b""
    end = time.time() + seconds
    while time.time() < end:
        try:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                buf += chunk
        except OSError:
            break
    return buf

def proc_state(pid):
    return subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                          capture_output=True, text=True).stdout.strip()

def spawn_zsh():
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execv("/bin/zsh", ["zsh", "-f", "-i"])
    drain(master, 1.5)
    return pid, master

def find_agent(zsh_pid):
    out = subprocess.run(["pgrep", "-P", str(zsh_pid), "-f", "bbarit"],
                         capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None

def cleanup(master, *pids):
    for p in pids:
        try:
            os.kill(p, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    os.close(master)

def test_a():
    zsh_pid, master = spawn_zsh()
    os.write(master, f"{AGENT}\n".encode())
    boot = drain(master, 5.0)
    if b"\x1b[?1049h" not in boot:
        print("A0 tui-boot:                FAIL"); cleanup(master, zsh_pid); return False
    agent_pid = find_agent(zsh_pid)
    if not agent_pid:
        print("A0 agent-not-found:         FAIL"); cleanup(master, zsh_pid); return False
    os.kill(agent_pid, signal.SIGTSTP)
    stopped_out = drain(master, 2.0)
    state = proc_state(agent_pid)
    ok_restore = all(m in stopped_out for m in RESTORE_MARKS)
    ok_stopped = state.startswith("T")
    ok_prompt = b"suspended" in stopped_out
    print(f"A1 restore-seq-before-stop: {'PASS' if ok_restore else 'FAIL'}")
    print(f"A2 actually-stopped:        {'PASS' if ok_stopped else 'FAIL'} (state={state})")
    print(f"A3 zsh-prompt-back:         {'PASS' if ok_prompt else 'FAIL'}")
    os.write(master, b"fg\n")
    resumed = drain(master, 3.0)
    ok_resume = b"\x1b[?1049h" in resumed and b"\x1b[?1006h" in resumed
    print(f"A4 fg-reenters-tui:         {'PASS' if ok_resume else 'FAIL'}")
    cleanup(master, agent_pid, zsh_pid)
    return ok_restore and ok_stopped and ok_prompt and ok_resume

def test_b():
    thief = tempfile.NamedTemporaryFile("w", suffix=".py", delete=False)
    thief.write(THIEF_SRC); thief.close()
    zsh_pid, master = spawn_zsh()
    os.write(master, f"python3 {thief.name} &\n".encode())
    drain(master, 0.5)
    os.write(master, f"{AGENT}\n".encode())
    drain(master, 5.0)  # TUI 부팅 (도둑은 5초 뒤 발화)
    agent_pid = find_agent(zsh_pid)
    if not agent_pid:
        print("B0 agent-not-found:         FAIL"); cleanup(master, zsh_pid); return False
    drain(master, 4.0)  # 도둑 발화 + 사망 대기
    time.sleep(1.0)
    # SIGTTIN은 입력이 도착해 read()가 일어나는 순간 발생한다 — 입력을 보내
    # 읽기를 강제한 뒤의 상태가 진짜 판정 기준.
    os.write(master, b"x")
    after = drain(master, 2.0)
    state = proc_state(agent_pid)
    ok_alive = bool(state) and not state.startswith("T")
    ok_no_suspend = b"suspended" not in after
    print(f"B1 no-sigttin-stop:         {'PASS' if ok_alive else 'FAIL'} (state={state})")
    print(f"B2 no-suspend-message:      {'PASS' if ok_no_suspend else 'FAIL'}")
    cleanup(master, agent_pid, zsh_pid)
    os.unlink(thief.name)
    return ok_alive and ok_no_suspend

if __name__ == "__main__":
    if not os.path.exists(AGENT):
        sys.exit(f"먼저 빌드하세요: cargo build ({AGENT} 없음)")
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    ok = True
    if which in ("a", "all"):
        ok &= test_a()
    if which in ("b", "all"):
        ok &= test_b()
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
