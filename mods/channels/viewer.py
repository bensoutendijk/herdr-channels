# The viewer behind a task in the channels panel: `claude attach <session>` behind a pass-through
# terminal, started by mods/channels/main.js as `python3 -I -c <this file> <session>` on the
# machine the session runs on. A task on another harness passes the program to run after the
# session (`<session> codex resume <thread>`): it is attached to, and attached again, the same way.
#
# Why not run `claude attach` directly: when you leave a session (left arrow on an empty prompt,
# /exit, ctrl+z), Claude Code restores the screen within a couple of milliseconds but then takes
# about 300 ms more to exit. The panel should go back to the task list at the first of those, not
# the second. So this sits between the terminal and `claude attach`, copies bytes both ways, and
# watches the output for the screen being restored. At that moment it blanks the screen, marks its
# terminal (the "herdr.back" label the panel watches), ends that attach without waiting for it,
# and after a pause attaches again so the task is ready the next time it is opened.
#
# `--settings {"disableAgentView":true}` keeps Claude Code's own agents list out of reach: with
# it, leaving ends the attach instead of opening that list.
import fcntl
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time
import tty

SESSION = sys.argv[1]
PROGRAM = sys.argv[2:] or ["claude", "attach", SESSION, "--settings", '{"disableAgentView":true}']
ENTER, LEAVE = b"\x1b[?1049h", b"\x1b[?1049l"  # the alternate screen being entered and restored
QUICK = 3  # seconds: an attach that ends sooner than this, before its screen came up, failed
child = None  # the pty of the running attach, for the resize handler


def fit(*_):
    """Gives the attach the size of the terminal this runs in."""
    if child is None:
        return
    try:
        fcntl.ioctl(child, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
    except OSError:
        pass


def mark(stamp):
    """Tells the panel you left: changes this terminal's label, without waiting for it."""
    terminal = os.environ.get("HC_TERMINAL_ID")
    if terminal:
        subprocess.Popen(["hc", "label", terminal, "herdr.back=%s" % stamp],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def attach(count):
    """One attach, until you leave it or it ends. True when its screen came up."""
    global child
    pid, child = pty.fork()
    if pid == 0:
        os.execvp(PROGRAM[0], PROGRAM)
    fit()
    shown, seen, done = False, b"", False
    while not done:
        try:
            ready, _, _ = select.select([0, child], [], [])
        except InterruptedError:  # a resize arrived
            continue
        if 0 in ready:
            data = os.read(0, 4096)
            if not data:  # the terminal itself is closing
                os.kill(pid, signal.SIGHUP)
                sys.exit(0)
            os.write(child, data)
        if child in ready:
            try:
                data = os.read(child, 65536)
            except OSError:
                data = b""
            if not data:
                break
            window = seen + data
            if not shown and ENTER in window:
                shown = True
                window = window.split(ENTER, 1)[1]
            if shown and LEAVE in window:
                # Keep what restores the terminal's modes, drop anything after it.
                data = data[: len(data) - (len(window) - window.index(LEAVE) - len(LEAVE))] if LEAVE in data else data
                done = True
            os.write(1, data)
            seen = (seen + data)[-len(ENTER):]
    os.write(1, b"\x1b[0m\x1b[2J\x1b[H")  # a blank screen until the panel has moved on
    mark("%d.%d" % (time.time(), count))
    fd, child = child, None
    try:
        os.kill(pid, signal.SIGKILL)  # the attach was already leaving; don't wait for its slow exit
    except OSError:
        pass
    os.close(fd)
    os.waitpid(pid, 0)
    return shown


def main():
    saved = termios.tcgetattr(0)
    signal.signal(signal.SIGWINCH, fit)
    failures, count = 0, 0
    try:
        while failures < 3:
            tty.setraw(0)
            started = time.time()
            count += 1
            shown = attach(count)
            failures = 0 if shown or time.time() - started >= QUICK else failures + 1
            time.sleep(1)
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, saved)


main()
