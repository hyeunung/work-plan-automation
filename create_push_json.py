import json
import os

files = [
    ".github/workflows/daily-scheduler.yml",
    "src/app.js",
    "src/config.js",
    "src/services/notionService.js",
    "src/services/slackService.js"
]

files_data = []
for fpath in files:
    full_path = os.path.join("/Users/scott/workspace/WorkPlan", fpath)
    with open(full_path, 'r', encoding='utf-8') as f:
        content = f.read()
    files_data.append({
        "path": fpath,
        "content": content
    })

output = {
    "owner": "hyeunung",
    "repo": "work-plan-automation",
    "branch": "main",
    "message": "feat: 지연 태스크 감지 알림 파이프라인 추가 및 깃허브 워크플로우 업데이트",
    "files": files_data
}

with open("/Users/scott/workspace/WorkPlan/files_to_push.json", 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print("JSON file created at /Users/scott/workspace/WorkPlan/files_to_push.json")
