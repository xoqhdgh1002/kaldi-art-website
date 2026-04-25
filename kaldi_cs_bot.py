#!/usr/bin/env python3
"""
Kaldi Art CS Bot
---------------
고객 요구사항을 텔레그램으로 받아 Kaldi Art 프로젝트를 자동 수정하고
변경 내용을 구조화된 메시지로 텔레그램에 반환합니다.

실행:
  python3 kaldi_cs_bot.py

중단:
  Ctrl+C  또는  텔레그램에서 /stop → yes
"""

import os
import re
import queue
import subprocess
import threading
import urllib.request
import json
import time
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional

# ── 설정 ───────────────────────────────────────────────────────────────────────

def load_env(path: str) -> dict:
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env

SCRIPT_DIR = Path(__file__).parent
cfg = load_env(str(SCRIPT_DIR / "kaldi_cs_bot.env"))

BOT_TOKEN  = os.environ.get("TELEGRAM_BOT_TOKEN") or cfg.get("TELEGRAM_BOT_TOKEN", "")
WORK_DIR   = os.environ.get("WORK_DIR") or cfg.get("WORK_DIR", str(SCRIPT_DIR))
CLAUDE_TIMEOUT = 600  # 최대 실행 시간 (초)

# 요청을 보낼 수 있는 유저 ID 목록
OWNER_ID           = int(os.environ.get("TELEGRAM_USER_ID") or cfg.get("TELEGRAM_USER_ID", "0"))
AUTHORIZED_USER_IDS: set = {OWNER_ID, 1548624015}  # 오너 + 추가 허용 유저

LOG_FILE    = SCRIPT_DIR / "cs_requests.log"
OFFSET_FILE = SCRIPT_DIR / "kaldi_cs_bot.offset"

# 봇 username (시작 시 getMe로 채워짐 — 맨션 감지에 사용)
BOT_USERNAME = ""

if not BOT_TOKEN:
    print("[오류] TELEGRAM_BOT_TOKEN이 설정되지 않았습니다. kaldi_cs_bot.env 파일을 확인하세요.")
    sys.exit(1)
if OWNER_ID == 0:
    print("[오류] TELEGRAM_USER_ID가 설정되지 않았습니다. kaldi_cs_bot.env 파일을 확인하세요.")
    sys.exit(1)

# ── CS 시스템 프롬프트 ─────────────────────────────────────────────────────────

# 오너용: 기술적 상세 보고
CS_PROMPT_OWNER = """\
당신은 Kaldi Art CS Bot입니다. Kaldi Art는 한국 현대미술 어드바이저리 및 에디토리얼 플랫폼이며 순수 HTML/CSS/JS 기반 SPA입니다.

[프로젝트 경로]
{work_dir}

[고객 요청]
{request}

[판단 기준 — 반드시 먼저 요청 유형을 구분하세요]

▶ 유형 A: 단순 문의·질문 (사용법, 소개, 기능 확인 등)
  - 코드 수정 없이 친절한 CS 안내 메시지만 출력합니다.
  - 아래 형식으로만 출력합니다:

---REPLY_START---
(친절한 한국어 CS 안내 메시지만 작성. 2~4문장 이내로 간결하게.)
---REPLY_END---

▶ 유형 B: 기능 수정·버그 수정·UI 개선 요청
  - 코드를 수정합니다 (주로 index.html 등 HTML/CSS/JS 파일).
  - 수정이 완료되면 반드시 `git pull origin main --rebase` 후 `git add -A`, `git commit`, `git push origin main`을 수행합니다. (빌드 단계는 없습니다)
  - 아래 형식으로만 출력합니다:

---REPORT_START---
📋 요청 내용
{request}

🔧 변경 파일
(수정된 파일 목록)

✏️ 변경 내용
(변경사항을 항목별로 간결하게 설명)

✅ 수정 결과
(성공 / 실패 + 오류 메시지)
---REPORT_END---
"""

# 일반 유저용: 사용자 친화적 보고 (기술적 내용 없음)
CS_PROMPT_USER = """\
당신은 Kaldi Art CS Bot입니다. Kaldi Art는 한국 현대미술 어드바이저리 및 에디토리얼 플랫폼이며 순수 HTML/CSS/JS 기반 SPA입니다.

[프로젝트 경로]
{work_dir}

[고객 요청]
{request}

[판단 기준 — 반드시 먼저 요청 유형을 구분하세요]

▶ 유형 A: 단순 문의·질문 (사용법, 소개, 기능 확인 등)
  - 코드 수정 없이 친절한 CS 안내 메시지만 출력합니다.
  - "~버튼을 눌러보세요", "~화면에서 확인하실 수 있습니다" 등 실용적인 안내를 합니다.
  - 아래 형식으로만 출력합니다:

---REPLY_START---
(친절한 한국어 CS 안내 메시지만 작성. 2~4문장 이내로 간결하게.)
---REPLY_END---

▶ 유형 B: 기능 수정·버그 수정·UI 개선 요청
  - 코드를 수정합니다 (주로 index.html 등 HTML/CSS/JS 파일).
  - 수정이 완료되면 반드시 `git pull origin main --rebase` 후 `git add -A`, `git commit`, `git push origin main`을 수행합니다. (빌드 단계는 없습니다)
  - 완료 후 아래 형식으로만 출력합니다. 파일명·기술적 내용은 절대 포함하지 않습니다.

---REPORT_START---
📋 요청 내용
{request}

✏️ 변경 내용
(웹사이트에서 어떻게 보이는지 이용자 관점으로 1~3줄 설명.)

👀 확인 방법
(웹사이트의 어느 화면에서 무엇을 보면 변경 내용을 확인할 수 있는지 한 줄로 안내)
---REPORT_END---
"""

# ── 전역 상태 ──────────────────────────────────────────────────────────────────

stats = {"total": 0, "success": 0, "error": 0, "started_at": datetime.now()}
_task_queue: queue.Queue = queue.Queue()
_session_id: Optional[str] = None
_session_lock = threading.Lock()
_pending_stop = False
_pending_stop_lock = threading.Lock()
_stop_timer: Optional[threading.Timer] = None

# ── Telegram API ───────────────────────────────────────────────────────────────

def tg(method: str, **params) -> dict:
    url  = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    data = json.dumps(params).encode("utf-8")
    req  = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"[CS Bot] Telegram API 오류 ({method}): {e}")
        return {}


def send(chat_id: int, text: str, parse_mode: str = "") -> Optional[int]:
    """4096자 초과 시 자동 분할 전송. 첫 번째 메시지의 message_id를 반환."""
    if not text:
        text = "(응답 없음)"
    kwargs: dict = {"chat_id": chat_id}
    if parse_mode:
        kwargs["parse_mode"] = parse_mode
    first_msg_id = None
    for i in range(0, max(len(text), 1), 4096):
        result = tg("sendMessage", **kwargs, text=text[i:i + 4096])
        if first_msg_id is None:
            first_msg_id = result.get("result", {}).get("message_id")
    return first_msg_id


def delete_message(chat_id: int, message_id: int):
    """메시지를 삭제합니다."""
    tg("deleteMessage", chat_id=chat_id, message_id=message_id)


def fetch_bot_username() -> str:
    result = tg("getMe")
    return result.get("result", {}).get("username", "").lower()


def is_mentioned(text: str, chat_type: str) -> bool:
    """개인 채팅은 항상 True, 그룹은 @봇이름 맨션 시에만 True."""
    if chat_type == "private":
        return True
    if not BOT_USERNAME:
        return True  # username 조회 실패 시 허용
    return f"@{BOT_USERNAME}" in text.lower()


def strip_mention(text: str) -> str:
    """텍스트에서 @봇이름 맨션을 제거합니다."""
    if not BOT_USERNAME:
        return text
    return re.sub(rf"@{re.escape(BOT_USERNAME)}", "", text, flags=re.IGNORECASE).strip()


def load_offset() -> int:
    try:
        return int(OFFSET_FILE.read_text().strip())
    except Exception:
        return 0


def save_offset(offset: int):
    try:
        OFFSET_FILE.write_text(str(offset))
    except Exception:
        pass

# ── 요청 로그 ──────────────────────────────────────────────────────────────────

def log_request(seq: int, request: str):
    """고객 요청을 타임스탬프와 함께 로그 파일에 저장합니다."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] #{seq} | {request}\n"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        print(f"[CS Bot] 로그 저장 실패: {e}")


def read_recent_log(n: int = 10) -> str:
    """최근 N건의 요청 로그를 반환합니다."""
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
        recent = lines[-n:] if len(lines) >= n else lines
        return "\n".join(recent) if recent else "(요청 이력 없음)"
    except FileNotFoundError:
        return "(요청 이력 없음)"
    except Exception as e:
        return f"(로그 읽기 실패: {e})"

# ── Claude 실행 ────────────────────────────────────────────────────────────────

def run_claude(prompt: str, chat_id: int) -> str:
    global _session_id

    with _session_lock:
        sid = _session_id

    cmd = ["claude", "--dangerously-skip-permissions", "-p", "--output-format", "json"]
    if sid:
        cmd += ["--resume", sid]
    cmd.append(prompt)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=WORK_DIR,
    )

    # 진행 중 typing 액션 전송
    stop_event = threading.Event()
    def _typing():
        while not stop_event.wait(timeout=4):
            tg("sendChatAction", chat_id=chat_id, action="typing")
    threading.Thread(target=_typing, daemon=True).start()

    try:
        stdout, stderr = proc.communicate(timeout=CLAUDE_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        stop_event.set()
        return f"❌ 타임아웃: {CLAUDE_TIMEOUT // 60}분 내에 응답하지 않아 강제 종료했습니다."
    finally:
        stop_event.set()

    raw = stdout.strip()
    if not raw:
        return stderr.strip() or "(출력 없음)"

    try:
        data = json.loads(raw)
        new_sid = data.get("session_id")
        if new_sid:
            with _session_lock:
                _session_id = new_sid
        return (data.get("result") or raw).strip()
    except json.JSONDecodeError:
        return raw


def extract_report(full_output: str) -> str:
    """Claude 출력에서 응답 블록을 추출합니다."""
    # 유형 A: 단순 문의 응답
    rs = full_output.find("---REPLY_START---")
    re_ = full_output.find("---REPLY_END---")
    if rs != -1 and re_ != -1:
        return full_output[rs + len("---REPLY_START---"):re_].strip()

    # 유형 B: 코드 수정 보고
    rs = full_output.find("---REPORT_START---")
    re_ = full_output.find("---REPORT_END---")
    if rs != -1 and re_ != -1:
        return full_output[rs + len("---REPORT_START---"):re_].strip()

    # 블록이 없으면 전체 반환
    return full_output.strip()

# ── 배포 (git commit + push) ───────────────────────────────────────────────────

def deploy(seq: int) -> str:
    """변경된 파일을 git commit+push 합니다.
    반환값: 배포 결과 문자열 (오너 전용 알림용)
    """
    lines = []
    try:
        # ── Git commit + push ───────────────────────────────────────────────
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, cwd=WORK_DIR, timeout=30
        )
        if status.stdout.strip():
            subprocess.run(
                ["git", "pull", "origin", "main", "--rebase"],
                capture_output=True, text=True, cwd=WORK_DIR, timeout=60
            )
            subprocess.run(
                ["git", "add", "-A"],
                capture_output=True, text=True, cwd=WORK_DIR, timeout=30
            )
            commit = subprocess.run(
                ["git", "commit", "-m", f"cs-bot: auto-deploy for request #{seq}"],
                capture_output=True, text=True, cwd=WORK_DIR, timeout=30
            )
            if commit.returncode == 0:
                push = subprocess.run(
                    ["git", "push", "origin", "main"],
                    capture_output=True, text=True, cwd=WORK_DIR, timeout=60
                )
                hash_proc = subprocess.run(
                    ["git", "rev-parse", "--short", "HEAD"],
                    capture_output=True, text=True, cwd=WORK_DIR, timeout=10
                )
                short_hash = hash_proc.stdout.strip()
                if push.returncode == 0:
                    lines.append(f"✅ Git push 완료 (commit: {short_hash})")
                else:
                    lines.append(f"❌ Git push 실패: {push.stderr.strip()[:200]}")
            else:
                lines.append("⚠️ Git commit 없음 (변경 없음)")
        else:
            lines.append("⚠️ Git 변경 없음 (스킵)")

    except subprocess.TimeoutExpired:
        lines.append("❌ 배포 타임아웃")
    except Exception as e:
        lines.append(f"❌ 배포 오류: {e}")

    return "\n".join(lines)


def is_code_change(raw_output: str) -> bool:
    """Claude 출력이 코드 수정(유형 B)인지 여부를 반환합니다."""
    return "---REPORT_START---" in raw_output


# ── 작업 큐 워커 ───────────────────────────────────────────────────────────────

def task_worker():
    while True:
        item = _task_queue.get()
        if item is None:
            _task_queue.task_done()
            break

        chat_id, request, seq, sender_id, wait_msg_id = item
        is_owner = (sender_id == OWNER_ID)
        template = CS_PROMPT_OWNER if is_owner else CS_PROMPT_USER
        try:
            prompt     = template.format(work_dir=WORK_DIR, request=request)
            raw_output = run_claude(prompt, chat_id)
            report     = extract_report(raw_output)
            code_changed = is_code_change(raw_output)
            stats["success"] += 1
            print(f"[CS Bot] #{seq} 완료 (코드 변경: {code_changed})")

            # 완료 메시지 전송 후 대기 메시지 삭제 (오너 외 유저만)
            if is_owner:
                send(chat_id, f"✅ 작업 완료 (#{seq})\n\n{report}")
            else:
                send(chat_id, report)
                if wait_msg_id:
                    delete_message(chat_id, wait_msg_id)

            # 코드 수정이 있었을 경우 자동 배포 + 오너에게만 알림
            if code_changed:
                deploy_result = deploy(seq)
                print(f"[CS Bot] #{seq} 배포: {deploy_result}")
                send(OWNER_ID, f"🚀 자동 배포 결과 (#{seq})\n\n{deploy_result}")

        except FileNotFoundError:
            stats["error"] += 1
            send(chat_id, "❌ `claude` 명령어를 찾을 수 없습니다. PATH를 확인해 주세요.")
            if wait_msg_id and not is_owner:
                delete_message(chat_id, wait_msg_id)
        except Exception as e:
            stats["error"] += 1
            send(chat_id, f"❌ 처리 중 오류 발생 (#{seq}): {e}")
            if wait_msg_id and not is_owner:
                delete_message(chat_id, wait_msg_id)
        finally:
            _task_queue.task_done()

# ── 슬래시 명령 ────────────────────────────────────────────────────────────────

def cmd_status(chat_id: int):
    uptime = datetime.now() - stats["started_at"]
    h, rem = divmod(int(uptime.total_seconds()), 3600)
    m, _   = divmod(rem, 60)
    send(chat_id,
        f"🤖 Kaldi Art CS Bot 상태\n\n"
        f"업타임: {h}시간 {m}분\n"
        f"총 요청: {stats['total']}건  (성공 {stats['success']} / 실패 {stats['error']})\n"
        f"대기 중: {_task_queue.qsize()}건\n"
        f"작업 디렉토리: {WORK_DIR}"
    )


def cmd_log(chat_id: int):
    log = read_recent_log(10)
    send(chat_id, f"📋 최근 요청 10건\n\n{log}")


def cmd_new(chat_id: int):
    global _session_id
    with _session_lock:
        _session_id = None
    send(chat_id, "🔄 Claude 세션을 초기화했습니다. 다음 요청부터 새 세션으로 시작합니다.")


def cmd_stop_request(chat_id: int):
    global _pending_stop, _stop_timer

    def expire():
        global _pending_stop
        with _pending_stop_lock:
            _pending_stop = False
        send(chat_id, "↩️ 종료 확인 시간 초과. 취소됐습니다.")

    with _pending_stop_lock:
        _pending_stop = True
    if _stop_timer and _stop_timer.is_alive():
        _stop_timer.cancel()
    _stop_timer = threading.Timer(30, expire)
    _stop_timer.daemon = True
    _stop_timer.start()
    send(chat_id, "⚠️ CS Bot을 종료하려면 30초 내에 `yes`를 입력하세요.")

# ── 메인 루프 ──────────────────────────────────────────────────────────────────

def register_commands():
    tg("setMyCommands", commands=[
        {"command": "status", "description": "봇 상태 및 통계 확인"},
        {"command": "log",    "description": "최근 요청 10건 조회"},
        {"command": "new",    "description": "Claude 세션 초기화"},
        {"command": "stop",   "description": "봇 종료 (yes로 확인)"},
    ])


def main():
    global _pending_stop, _stop_timer, BOT_USERNAME

    print(f"[CS Bot] 시작 — 작업 디렉토리: {WORK_DIR}")
    print(f"[CS Bot] 허용된 user_ids: {AUTHORIZED_USER_IDS}")

    BOT_USERNAME = fetch_bot_username()
    if BOT_USERNAME:
        print(f"[CS Bot] 봇 username: @{BOT_USERNAME}")

    register_commands()

    worker = threading.Thread(target=task_worker, daemon=True, name="cs-worker")
    worker.start()

    send(OWNER_ID,
        "🤖 *Kaldi Art CS Bot* 시작됨\n\n"
        "고객 요구사항을 텍스트로 보내주시면 프로젝트를 분석·수정하고 결과를 보고합니다.\n\n"
        "명령어: /status · /log · /new · /stop",
        parse_mode="Markdown"
    )

    offset = load_offset()

    while True:
        try:
            resp    = tg("getUpdates", offset=offset, timeout=20, allowed_updates=["message"])
            updates = resp.get("result", [])

            for update in updates:
                msg       = update.get("message", {})
                chat_id   = msg.get("chat", {}).get("id")
                sender_id = msg.get("from", {}).get("id")
                text      = (msg.get("text") or "").strip()
                chat_type = msg.get("chat", {}).get("type", "private")
                new_offset = update["update_id"] + 1

                # 허용된 유저가 아니거나 빈 메시지는 무시
                if sender_id not in AUTHORIZED_USER_IDS or not text:
                    offset = new_offset
                    save_offset(offset)
                    continue

                # 그룹 채팅에서는 맨션이 있을 때만 응답
                if not is_mentioned(text, chat_type):
                    offset = new_offset
                    save_offset(offset)
                    continue

                # 맨션 제거 후 실제 요청 텍스트 추출
                text = strip_mention(text)
                if not text:
                    offset = new_offset
                    save_offset(offset)
                    continue

                # /stop, /new 등 관리 명령은 오너만 사용 가능
                cmd_key = text.split()[0].lower().lstrip("/").split("@")[0]
                is_owner = (sender_id == OWNER_ID)

                # /stop 확인 대기 중 (오너만)
                with _pending_stop_lock:
                    pending = _pending_stop

                if pending and is_owner:
                    if text.lower() == "yes":
                        send(chat_id, "🛑 CS Bot 종료.")
                        print("[CS Bot] 종료.")
                        if _stop_timer:
                            _stop_timer.cancel()
                        _task_queue.put(None)
                        offset = new_offset
                        save_offset(offset)
                        sys.exit(0)
                    else:
                        with _pending_stop_lock:
                            _pending_stop = False
                        if _stop_timer:
                            _stop_timer.cancel()
                        send(chat_id, "↩️ 종료 취소됐습니다.")
                        offset = new_offset
                        save_offset(offset)
                        continue

                # 슬래시 명령 처리 (오너만)
                if cmd_key in ("status", "log", "new", "stop", "quit") and is_owner:
                    if cmd_key == "status":
                        cmd_status(chat_id)
                    elif cmd_key == "log":
                        cmd_log(chat_id)
                    elif cmd_key == "new":
                        cmd_new(chat_id)
                    elif cmd_key in ("stop", "quit"):
                        cmd_stop_request(chat_id)
                else:
                    # 일반 요청 → 큐에 추가
                    stats["total"] += 1
                    seq = stats["total"]
                    log_request(seq, text)
                    queued = _task_queue.qsize()
                    is_owner_msg = (sender_id == OWNER_ID)
                    wait_text = (
                        f"⏳ 요청을 분석 중입니다... (#{seq})"
                        if queued == 0
                        else f"⏳ 대기 중... (#{seq}, 앞에 {queued}건)"
                    )
                    if is_owner_msg:
                        wait_msg_id = send(chat_id, f"{wait_text}\n\n`{text[:200]}`", parse_mode="Markdown")
                    else:
                        wait_msg_id = send(chat_id, wait_text)
                    _task_queue.put((chat_id, text, seq, sender_id, wait_msg_id))
                    print(f"[CS Bot] #{seq} 수신: {text[:100]}")

                offset = new_offset
                save_offset(offset)

        except KeyboardInterrupt:
            print("\n[CS Bot] 종료.")
            send(OWNER_ID, "🛑 Kaldi Art CS Bot 종료됨.")
            _task_queue.put(None)
            break
        except Exception as e:
            print(f"[CS Bot] 폴링 오류: {e}")
            time.sleep(5)


if __name__ == "__main__":
    main()
