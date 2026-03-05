from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from browser_use import Agent, BrowserProfile, BrowserSession, ChatAnthropic
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

llm = ChatAnthropic(model="claude-opus-4-5")

SKILLS_DIR = Path('./skills')
LOGS_DIR = Path('./logs')
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class TaskRequest(BaseModel):
    task: str
    task_type: Optional[str] = None


# ---------------------------------------------------------------------------
# Domain / skill key helpers
# ---------------------------------------------------------------------------

def sanitize_domain(raw: str) -> str:
    raw = raw.lower().strip()
    raw = re.sub(r':\d+$', '', raw)          # strip port
    if raw.startswith('www.'):
        raw = raw[4:]
    raw = re.sub(r'[.\-]', '_', raw)         # dots & hyphens → underscores
    raw = re.sub(r'[^a-z0-9_]', '', raw)     # strip everything else
    return raw


def extract_domain_from_task(task: str) -> str:
    url_pattern = re.compile(
        r'https?://[^\s/$.?#].[^\s]*'
        r'|\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b',
        re.IGNORECASE,
    )
    match = url_pattern.search(task)
    if match:
        raw_url = match.group(0)
        parsed = urlparse(raw_url if '://' in raw_url else 'https://' + raw_url)
        netloc = parsed.netloc or parsed.path.split('/')[0]
        sanitized = sanitize_domain(netloc)
        if sanitized:
            return sanitized
    return 'task_' + hashlib.md5(task[:100].encode()).hexdigest()[:8]


def build_skill_key(task_type: str | None, task: str) -> str:
    domain = extract_domain_from_task(task)
    if task_type:
        clean_type = re.sub(r'[\s\-]', '_', task_type.lower())
        clean_type = re.sub(r'[^a-z0-9_]', '', clean_type)
        return f'{domain}__{clean_type}'
    suffix = hashlib.md5(task[:100].encode()).hexdigest()[:8]
    return f'{domain}__{suffix}'


# ---------------------------------------------------------------------------
# Skill I/O
# ---------------------------------------------------------------------------

def get_skill_path(skill_key: str) -> Path:
    return SKILLS_DIR / f'{skill_key}.json'


def load_skill(skill_key: str) -> dict | None:
    path = get_skill_path(skill_key)
    if not path.exists():
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning('Failed to load skill %s: %s', skill_key, e)
        return None


def save_skill(skill_key: str, skill_data: dict) -> bool:
    path = get_skill_path(skill_key)
    try:
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(skill_data, f, indent=2, ensure_ascii=False)
        tmp.replace(path)
        return True
    except OSError as e:
        logger.error('Failed to save skill %s: %s', skill_key, e)
        return False


def build_skill_from_result(
    skill_key: str,
    task_type: str | None,
    task: str,
    result,
    existing: dict | None,
) -> dict:
    run_count = (existing.get('run_count', 0) if existing else 0) + 1
    domain_part = skill_key.split('__')[0] if '__' in skill_key else skill_key
    is_curated = existing.get('curated', False) if existing else False
    return {
        'skill_key': skill_key,
        'task_type': task_type,
        'domain': domain_part,
        'curated': is_curated,
        'original_task': existing.get('original_task', task) if existing else task,
        'last_updated': datetime.utcnow().isoformat(),
        'run_count': run_count,
        # Preserve hand-curated steps — only update these for auto-generated skills
        'action_sequence': existing.get('action_sequence') if is_curated else result.action_names(),
        'step_descriptions': existing.get('step_descriptions') if is_curated else result.agent_steps(),
        'final_result_summary': result.final_result() or '',
    }


# ---------------------------------------------------------------------------
# Prompt injection
# ---------------------------------------------------------------------------

def build_skill_prompt_prefix(skill: dict) -> str:
    action_seq = skill.get('action_sequence', [])
    steps = skill.get('step_descriptions', [])
    run_count = skill.get('run_count', 1)
    last_updated = skill.get('last_updated', '')[:10]

    action_list_str = '\n'.join(
        f'  {i + 1}. {name}' for i, name in enumerate(action_seq)
    )
    steps_str = '\n'.join(steps).strip()

    return (
        f'\n=== SKILL REFERENCE (from {run_count} previous successful run(s),'
        f' last: {last_updated}) ===\n'
        f'This task has been completed before. Use the following as a reference only —\n'
        f'adapt as needed based on the current page state.\n\n'
        f'ACTION SEQUENCE:\n{action_list_str}\n\n'
        f'STEP-BY-STEP DETAILS:\n{steps_str}\n'
        f'=== END SKILL REFERENCE ===\n\n'
    )


def build_enriched_task(task: str, skill: dict | None) -> tuple[str, bool]:
    if skill is None:
        return task, False
    return build_skill_prompt_prefix(skill) + task, True


# ---------------------------------------------------------------------------
# Success check
# ---------------------------------------------------------------------------

def determine_success(result) -> bool:
    return result.is_done() and not result.has_errors()


# ---------------------------------------------------------------------------
# Run log
# ---------------------------------------------------------------------------

def save_run_log(
    skill_key: str,
    task: str,
    used_existing_skill: bool,
    success: bool,
    result,
    duration_seconds: float,
) -> bool:
    timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    log_dir = LOGS_DIR / skill_key
    log_path = log_dir / f'run_{timestamp}.json'

    log_data = {
        'task': task,
        'skill_key': skill_key,
        'used_existing_skill': used_existing_skill,
        'success': success,
        'action_names': result.action_names() if result is not None else [],
        'final_result': result.final_result() if result is not None else None,
        'duration_seconds': round(duration_seconds, 3),
        'errors': [e for e in result.errors() if e is not None] if result is not None else [],
    }

    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(log_path, 'w', encoding='utf-8') as f:
            json.dump(log_data, f, indent=2, ensure_ascii=False)
        return True
    except OSError as e:
        logger.error('Failed to write run log for %s: %s', skill_key, e)
        return False


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post('/run-task')
async def run_task(request: TaskRequest):
    skill_key = build_skill_key(request.task_type, request.task)
    existing_skill = load_skill(skill_key)
    enriched_task, used_existing_skill = build_enriched_task(request.task, existing_skill)

    start_time = time.monotonic()
    result = None

    try:
        browser_profile = BrowserProfile(
            executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            user_data_dir='~/Library/Application Support/Google/Chrome',
            profile_directory='Profile 5',
            args=[
                '--disable-features=ChromeWhatsNewUI',  # suppress post-update What's New page
                '--no-startup-window',                  # don't restore previous session windows
            ],
        )
        agent = Agent(
            task=enriched_task,
            llm=llm,
            browser_profile=browser_profile,
            use_vision=True,
            max_steps=40,
        )
        result = await agent.run()
        success = determine_success(result)

        if success:
            new_skill = build_skill_from_result(
                skill_key, request.task_type, request.task, result, existing_skill
            )
            save_skill(skill_key, new_skill)
            run_count = new_skill['run_count']
        else:
            run_count = existing_skill.get('run_count', 0) if existing_skill else 0

        save_run_log(
            skill_key, request.task, used_existing_skill, success, result,
            time.monotonic() - start_time,
        )
        return {
            'result': result.final_result(),
            'success': True,
            'skill_key': skill_key,
            'used_existing_skill': used_existing_skill,
            'run_count': run_count,
        }

    except Exception as e:
        save_run_log(
            skill_key, request.task, used_existing_skill, False, result,
            time.monotonic() - start_time,
        )
        return {
            'result': str(e),
            'success': False,
            'skill_key': skill_key,
            'used_existing_skill': used_existing_skill,
            'run_count': existing_skill.get('run_count', 0) if existing_skill else 0,
        }


@app.get('/skills')
async def list_skills():
    skills_metadata = []
    try:
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        for skill_file in sorted(SKILLS_DIR.glob('*.json')):
            try:
                with open(skill_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                skills_metadata.append({
                    'skill_key': data.get('skill_key', skill_file.stem),
                    'task_type': data.get('task_type'),
                    'domain': data.get('domain'),
                    'run_count': data.get('run_count', 0),
                    'last_updated': data.get('last_updated'),
                })
            except (json.JSONDecodeError, OSError) as e:
                logger.warning('Skipping corrupt skill file %s: %s', skill_file, e)
    except OSError as e:
        logger.error('Cannot read skills directory: %s', e)
    return {'skills': skills_metadata}


@app.delete('/skills/{skill_key}')
async def delete_skill(skill_key: str):
    if not re.match(r'^[a-z0-9_]+$', skill_key):
        raise HTTPException(status_code=400, detail='Invalid skill_key format')
    path = get_skill_path(skill_key)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f'Skill not found: {skill_key}')
    try:
        path.unlink()
        return {'deleted': True, 'skill_key': skill_key}
    except OSError as e:
        logger.error('Failed to delete skill %s: %s', skill_key, e)
        raise HTTPException(status_code=500, detail=f'Failed to delete skill: {e}')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=3002)
