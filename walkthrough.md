# Cockpit Walkthrough

## 2026-11-16 — 역할 에이전트·잠금 제거, 가상 사무실을 서브 호출 화면으로 전환

Hames가 16개 역할 에이전트 구조를 없애고 "메인 + 범용 서브 에이전트"로 바뀌었다. 워크스페이스 잠금은 2026-11-11에 이미 없어졌다. Cockpit도 여기에 맞췄다.

### 바꾼 것

- **`server/orchestrator.js`:** 역할별 자문 프롬프트와 역할 목록을 지웠다. 모든 작업은 메인 Hames로 실행하고, 작업 기록의 `agent`·`label`은 `"Hames"`다.
- **`server/index.js`:** `/api/spawn`은 `{prompt}`만 쓴다. `agent` 필드가 와도 무시한다.
- **`server/actions.js`:** `lock`·`unlock` 액션과 잠금 파일 쓰기, 감사 로그 쓰기(`appendAudit`)를 지웠다. Cockpit은 하네스 기록을 읽기만 한다.
- **`server/config.js`:** 기록 위치를 `Anti/.Arsenal/log_rotation.js`와 같은 규칙으로 찾는다(`HAMES_LOG_DIR`, 없으면 macOS `~/Library/Logs/Hames/`). Claude Code 프로젝트 기록 폴더(`~/.claude/projects/<ROOT를 바꾼 이름>`)를 찾는다.
- **`server/state.js`:** `/api/state`의 `agents`를 `subagents`(최근 24시간, 최대 12개, 최신순)로 바꿨다. 메타 파일의 `description`·`agentType`·`finished`와 기록 파일 수정 시각만 읽고 대화 본문은 읽지 않는다. 상태는 셋이다: `finished`가 `true`면 완료, 아니고 5분 안에 기록이 바뀌었으면 진행 중, 둘 다 아니면 `stale`(화면 "확인 필요") — 완료 기록이 없는 서브를 완료로 단정하지 않는다. `kpis.recentSubagentCalls`와 `dataSources.claudeSubagents`를 더했고 잠금 필드를 모두 지웠다. 잠금 기반 `activeWorkspace`는 지우고, 가장 최근 세션 기록의 워크스페이스를 `kpis.lastWorkspace`로 둔다(화면 표시 "Last Workspace").
- **`web/office.html`:** 가운데에 메인 Hames, 그 뒤에 최근 서브 에이전트를 아바타로 늘어놓는다. 진행 중이면 불이 켜지고, 서브가 하나라도 진행 중이면 메인도 켜진다. "Hames 루트에서 시작한 Claude Code 세션의 서브 호출만 표시합니다(Codex·LLM_Wiki·Study 세션 제외)." 안내를 넣었다. KPI는 "최근 서브 호출 수"로 바꿨다.
- **`web/app.js`:** Agents 메뉴와 역할 색상표, Operations의 역할 선택, Lock/Unlock 버튼과 잠금 표시를 지웠다.
- **규칙 점검 숫자:** 새 감사 기록은 통과를 `ALLOWED`로 남기므로 통과 수에 `PASS`와 `ALLOWED`를 함께 센다.

### 검증 (예시 값은 자리표시자)

```
$ PATH=/tmp/<임시>/fakebin:$PATH node server/index.js
Hames Cockpit → http://127.0.0.1:8765  (root: <HAMES_ROOT>)
GET /api/state → keys: auditFeed, dataSources, generatedAt, git, handoffs, kpis, platform, root, sessionFeed, skills, subagents, workspaces
  agents 없음 · kpis.lockedSessions 없음 · dataSources.lock 없음
  dataSources.sessionLog = <HOME>/Library/Logs/Hames/session_log.jsonl (exists)
  dataSources.claudeSubagents = <HOME>/.claude/projects/<PROJECT_KEY> (exists)
POST /api/spawn {"agent":"CFO","prompt":"테스트"} → {"ok":true,"jobId":"job_..."}
GET /api/jobs → agent "Hames", label "Hames"
POST /api/jobs/<id>/stop → {"ok":true}
POST /api/action {"type":"lock"} → {"ok":false,"error":"unknown action: lock"}
GET /office.html 200 · GET /index.html 200
```

가짜 `claude`(아무것도 하지 않고 끝나는 실행 파일)로 시험해 실제 모델은 부르지 않았다. macOS에서만 시험했고 Windows·Linux 동작은 시험하지 않았다.

## 2026-06-15 — Health 페이지 구현 (hames_doctor MRI)

Cockpit에 시스템 건강 상태(System Health) 페이지를 추가한다. 별도 비동기 엔드포인트 `/api/doctor`로
`hames_doctor.py`를 실행해 그 JSON 리포트를 시각화한다. 기존 `/api/state` 폴링 경로와 완전히 분리되며,
진입 시 1회 로드하고 Re-run 버튼을 누를 때만 재실행한다(폴링 없음).

### 변경 사항

파일별 변경 내역은 다음과 같다.

- **`server/doctor.js` (신규 생성)**
  - `runDoctor(cfg, opts)` 단일 export. `execFileSync('python3', [hames_doctor.py])`로 doctor를 동기 실행한다.
  - `cfg.arsenalDir`(이미 first-existing 해석된 값)이 있으면 그 경로의 `hames_doctor.py`를, 없으면 `cfg.root/Anti/.Arsenal/hames_doctor.py`를 사용한다.
  - 성공 결과만 모듈 레벨에서 약 30초(`TTL_MS`) 캐시한다. `refresh:true`면 캐시를 무시하고 강제 재실행한다.
  - `parseReport`는 stdout에서 첫 `{` 위치를 찾아 그 지점부터 `JSON.parse`한다 → 헤더 줄/BOM/공백 줄을 모두 견딘다.
  - 절대 throw하지 않는다. ENOENT(python3 없음), 타임아웃(15초), stderr, 파싱 실패를 각각 `{ ok:false, error }` 형태로 반환한다.
  - 출력 폭주 방지를 위해 `maxBuffer`를 4MB로 설정한다.

- **`server/index.js` (3개소 삽입)**
  1. `orchestrator` require 다음 줄에 `const { runDoctor } = require('./doctor');` 추가.
  2. 요청 핸들러의 `url.parse(req.url)`를 `url.parse(req.url, true)`로 바꾸고 `const refresh = parsed.query && parsed.query.refresh === '1';`를 추가한다. `true` 인자는 `parsed.query`를 객체로 만들 뿐 `pathname`은 동일하므로 기존 라우트는 영향이 없다.
  3. `/api/state` 블록 직후, `// --- API: action ---` 주석 바로 앞에 `GET /api/doctor` 라우트를 추가한다. `runDoctor(cfg, { refresh })` 결과를 200으로 내려보내며, 예외 시 500 + `{ ok:false, error }`로 응답한다.

- **`web/app.js` (Health 섹션 추가)**
  - `SECTIONS` 배열에 `{ id:"health", label:"Health", icon:"✚" }`를 harness 다음, git 앞에 삽입한다(최종 순서: overview, workspaces, agents, skills, harness, health, git, operations).
  - 모듈 레벨 상태 변수 3개 추가: `healthMounted`, `doctorData`(클라이언트 캐시), `doctorLoading`(in-flight 가드).
  - `render()`에 `else if (current === "health")` 분기를 operations와 default 사이에 추가한다. 진입 시 셸을 1회만 mount하고, 캐시가 있으면 즉시 재도색, 없으면 `fetchDoctor(false)`로 1회 로드한다. 이후 `/api/state` 폴링이 `#healthBody`를 덮어쓰지 않는다.
  - `setSection()`에 operations teardown 다음 줄로 `if (current === "health") { healthMounted = false; }`를 추가한다(별도 타이머는 없음).
  - Health 전용 함수 13개를 Operations 섹션 뒤, `var RENDERERS` 앞에 추가한다: `mountHealth`, `setHealthLoading`, `fetchDoctor`, `renderHealthBody`, `healthIcon`, `healthGauge`, `healthSummaryCard`, `healthToolsPanel`, `healthCredsPanel`, `credDetail`, `healthIssuesPanel`, `riskPill`, `healthActionsPanel`. 모두 ES5(var/function)이며 기존 헬퍼(`esc`, `num`, `arr`, `byId`, `svgDonut`, `viewHead`, `emptyBox`, `legRow`, `COL`)를 재사용한다.
  - 스펙 지시대로 Health는 `RENDERERS` 객체에 넣지 않으며, `navCount`에도 case를 추가하지 않는다(default가 null 반환 → 배지 없음).

- **`web/style.css` (말미 append)**
  - `HEALTH` 블록 추가: `.hx`/`.hx-ok`/`.hx-warn`/`.hx-fail`(상태 아이콘 색), `.tokdetail`/`.tok-note`(자격증명 토큰 상세), `.ichips`/`.ichip`/`.ichip-k`/`.ichip-n`(규칙 무결성 칩), `.riskpill`/`.risk-low`/`.risk-med`/`.risk-high`(권고 액션 위험도 필).
  - 모두 기존 CSS 변수(`--mono`, `--teal`, `--amber`, `--red`, `--text`, `--muted`)를 사용한다.

`web/index.html`은 스펙 확인대로 변경하지 않았다. `state.js`, `actions.js`, `config.js`, `orchestrator.js`도 건드리지 않았다.

### 테스트 결과

#### node --check (구문 검증)

```
=== doctor.js ===
OK doctor.js
=== index.js ===
OK index.js
=== app.js ===
OK app.js
```

세 파일 모두 통과한다. `style.css`는 검사 대상이 아니다.

#### 테스트 서버 기동 (비기본 포트 8799)

```
PID=50960
--- server startup log ---
Hames Cockpit → http://127.0.0.1:8799  (root: <HAMES_ROOT>)
```

#### curl /api/doctor — runtime_health.summary

`"runtime_health"` 키가 응답에 존재함을 확인했고, summary 객체는 다음과 같다.

```json
{
  "external_tools": {
    "ok": 7,
    "warn": 1,
    "fail": 0
  },
  "credentials": {
    "ok": 8,
    "warn": 0,
    "fail": 0
  },
  "ok": 15,
  "warn": 1,
  "fail": 0
}
```

추가 sanity 확인:

```
top-level keys: ['schema_version', 'scope', 'issues', 'recommended_actions', 'runtime_health', 'stale_permissions', 'arsenal_issues', 'rule_module_issues', 'workspace_isolation_issues', 'runtime_encoding_issues']
issues keys count: 13
recommended_actions count: 0
```

`issues`는 13개 키, `recommended_actions`는 0건(empty-state)으로 스펙의 GROUND-TRUTH 정정 #1, #2와 일치한다.

#### curl /api/state — Phase 1 정상 (head 200바이트)

```
{"generatedAt":"2026-06-14T20:47:09.623Z","root":"<HAMES_ROOT>","platform":"darwin","dataSources":{"sessionLog":{"path":"<HAMES_ROOT>/Anti/.Arsenal/.session_log.jsonl","exi
```

`/api/state`가 기존과 동일한 스냅샷을 정상 반환한다 → Phase 1 회귀 없음.

#### 테스트 서버 종료 확인

```
--- ps check for PID 50960 ---
(no such process)
--- port 8799 listener check ---
(no listener on 8799)
```

프로세스와 포트 리스너 모두 사라졌다 → 테스트 서버 정상 종료.

### 검증

스펙 충족 및 견고성 보장 내역은 다음과 같다.

- **엔드포인트 분리:** Health는 `/api/state`가 아닌 별도 `/api/doctor`를 사용한다. 진입 시 1회 + Re-run 시에만 호출하며 폴링하지 않는다 → doctor 실행(파이썬 프로세스) 비용을 5초 폴링에 묶지 않는다.
- **GROUND-TRUTH 정정 반영:** `issues`는 하드코딩하지 않고 `Object.keys(issues)`로 순회한다(13개 키 그대로). `recommended_actions`는 0건 empty-state를 정상 처리한다(`No recommended actions — system is clean.`). 게이지는 `runtime_health.summary`의 top-level `ok/warn/fail`을 사용한다.
- **escape 보장:** DOM에 삽입하는 모든 파일 출처 문자열을 `esc()`로 escape한다. 도구 패널의 `name`/`path`/`purpose`, 자격증명의 `name`/`source`/`detail`/`expiry`/`note`, 규칙 무결성 키, 권고 액션의 `action_type`/`target_path`/`proposed_change`/`risk_level`이 모두 escape된다. `title` 속성에 들어가는 `t.path`도 escape한다. 숫자는 `num()`으로 포맷한다.
- **never-throw 백엔드:** `doctor.js`는 어떤 경우에도 throw하지 않고 `{ ok:false, error }`를 반환한다. python3 부재(ENOENT), 15초 타임아웃, stderr, JSON 파싱 실패를 모두 개별 분기로 처리한다. 프런트의 `renderHealthBody`는 `report.ok === false`면 에러 박스를, `runtime_health`가 없으면 "No health data" 박스를 그려 부분 응답에도 안전하다.
- **캐시·재시도 안전성:** 성공 결과만 캐시(`_cache`)하므로 일시 실패가 캐시를 오염시키지 않는다. `doctorLoading` 가드로 중복 fetch를 막고, fetch 완료 시(.then 마지막) 항상 해제한다. 비동기 응답 도착 시 `current === "health"`를 확인해 다른 섹션으로 이동한 뒤의 도색을 막는다.
- **마운트 안정성:** Operations와 동일한 패턴으로 셸을 1회만 mount하고 `#healthBody`만 비동기 갱신한다 → 5초 `/api/state` 폴링이 Health DOM을 지우지 않는다.
- **컨벤션 준수:** 백엔드는 `'use strict';` + CommonJS + Node 빌트인만 사용(npm 의존성 0). 프런트는 단일 IIFE 내 ES5(var, `.then()/.catch()` 체인, function 선언)로 작성했고 2-스페이스 들여쓰기를 따른다. 모든 함수는 50줄 이하다.
- **회귀 없음:** `url.parse(req.url, true)`는 `pathname`을 동일하게 반환하고 어떤 기존 라우트도 `parsed.query`를 읽지 않으므로 영향이 없다. `/api/state` head 확인으로 Phase 1 무회귀를 입증했다.
