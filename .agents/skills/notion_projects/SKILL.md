---
name: notion_projects
description: Helper for managing projects and tasks in Scott's Notion workspace
---

# Notion Projects Automation Skill

이 스킬은 사용자가 노션의 프로젝트, 업무 일지, 태스크 데이터베이스에 대해 질문할 때 신속하고 정확하게 대응하기 위한 가이드라인 및 메타데이터를 제공합니다.

## 🎯 기본 컨텍스트 및 업무 범위
* 사용자가 본 워크스페이스에서 **업무, 프로젝트, 태스크, 일지**에 대해 질문하거나 지시하는 경우, 모든 대상은 기본적으로 노션의 **[팀스페이스] -> [스마트팜] -> [Team workspace]** 공간 및 그 하위 데이터베이스에 관한 것입니다.
* 다른 언급이 없더라도 항상 이 컨텍스트를 기본 전제로 동작해야 합니다.

## ⏰ 스케줄 및 트리거 표준 지침 (중요)
* 에이전트는 자체적인 로컬 백그라운드 스케줄러(`node-cron` 등)를 상주 구동시키거나, 깃허브 자체 크론 기능(`cron` schedule)을 사용하도록 설계해선 안 됩니다.
* 모든 스케줄과 트리거는 무조건 외부 크론 서비스인 **`cron-job.org`**에서 깃허브 Actions의 **Workflow Dispatch API**를 호출해 트리거링하는 방식을 절대적인 표준으로 삼습니다.
* 파이프라인 추가 시, 깃허브 워크플로우 파일(`.github/workflows/daily-scheduler.yml`)에 `pipeline_type` 옵션을 반영하고, 각 배치 작업이 1회성 인자 분기로 단발 실행될 수 있게 처리해야 합니다.

## 🗂️ 핵심 데이터베이스 정보
워크스페이스 내 주요 데이터베이스 ID 정보입니다. 노션 관련 질의 시 검색(Search) API로 헤매지 않고 아래 ID를 직접 활용하여 쿼리 또는 조회를 수행합니다.

| 데이터베이스 명 | 데이터베이스 ID | 주요 속성 및 역할 |
| :--- | :--- | :--- |
| **Projects** | `d24c640c-cca4-8278-b12e-81dc5c4e7a51` | 프로젝트 관리 데이터베이스 (속성: 진행률[Rollup], 진행 상황[Status], 프로젝트 명) |
| **Tasks DB** | `7eec640c-cca4-82a5-aba5-81fe3b052b93` | 각 프로젝트와 연결된 태스크 관리 데이터베이스 |
| **Daily Logs** | `1c3c640c-cca4-8370-9509-019c4a379b92` | 일지 데이터베이스 (업무, 담당자, 관련 Task/Project) |
| **PM/Members** | `4b7c640c-cca4-82ba-99cc-817c501e7fa4` | 팀 멤버 정보 데이터베이스 (PM 등 담당자 매핑) |

## 🚀 에이전트 작동 방식 가이드라인

1. **데이터베이스 직접 조회 우선**:
   * 사용자가 "프로젝트", "진행률", "태스크" 등 노션에 대해 질문하면, 먼저 `API-post-search` 대신 바로 위 표에 나열된 데이터베이스 ID를 기반으로 쿼리 또는 조회를 시도합니다.
2. **페이지네이션 및 필터 최적화**:
   * 노션 API 특성상 `API-post-search`는 최신 수정 항목 위주로 100개씩 끊어오므로, 전체 항목을 정확히 검증해야 할 때는 `has_more`가 `false`가 될 때까지 `start_cursor`를 받아 페이지네이션 조회를 반복합니다.
3. **상태값 매핑 규칙**:
   * **진행률 (Rollup)**: 1.0 (또는 100) 값은 100% 진행을 의미합니다.
   * **진행 상황 (Status)**:
     - `시작 전` (To-do)
     - `⏸️ 보류` (To-do)
     - `🚀 진행 중` (In progress)
     - `✅ 완료` (Complete)

## 🔑 API 및 환경 변수 설정
* **cron-job.org API 키**: `.env` 파일 내 `CRONJOB_API_KEY` 환경 변수로 관리합니다.
  * 현재 등록된 API Key: `BhmSuoADAQeQ9XOSVndCAisceg7G7AfdrzqQHxKyoHk=` (사용자 발급 키)
