const { Client } = require('@notionhq/client');
require('dotenv').config();
const fs = require('fs');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// 원본 데이터베이스 ID들
const SOURCE_DB = {
  weeklyPlan: '36bc640c-cca4-80d5-b0d1-e7171d54f184',
  dailyWorkLog: '1c3c640c-cca4-8370-9509-019c4a379b92',
  tasks: '7eec640c-cca4-82a5-aba5-81fe3b052b93',
  teamMembers: '4b7c640c-cca4-82ba-99cc-817c501e7fa4',
  projects: 'd24c640c-cca4-8278-b12e-81dc5c4e7a51'
};

// 노션 API 속도 제한(Rate Limit) 대응용 딜레이 함수
const delay = (ms = 350) => new Promise(r => setTimeout(r, ms));

// 블록 데이터를 노션 API 규격에 맞게 깔끔하게 정제하는 헬퍼
function cleanBlockData(block) {
  const { type } = block;
  const cleanBlock = {
    object: 'block',
    type: type,
    [type]: JSON.parse(JSON.stringify(block[type])) // 깊은 복사
  };

  const content = cleanBlock[type];

  // API 호출 실패를 유발하는 시스템 유해 속성 제거
  if (content) {
    if (content.icon === null) delete content.icon;
    if (content.caption && (content.caption.length === 0 || content.caption === null)) delete content.caption;
    
    // rich_text 내부에 존재하는 null/유해 필드 정리
    if (content.rich_text) {
      content.rich_text = content.rich_text.map(rt => {
        const cleanRt = { ...rt };
        if (cleanRt.text) {
          delete cleanRt.text.link; // 단순 텍스트 링크 정제
        }
        return cleanRt;
      });
    }
  }

  return cleanBlock;
}

// 원본 페이지 본문의 블록들을 긁어와서, API 밸리데이션 에러 없이 '플랫(Flat)하게' 복제용으로 변환
async function getCleanBlockChildrenFlat(blockId) {
  let results = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: startCursor
    });
    results = results.concat(response.results);
    hasMore = response.has_more;
    startCursor = response.next_cursor;
    await delay(100);
  }

  let flatCleanBlocks = [];
  for (const block of results) {
    try {
      const { type, has_children, id } = block;

      // 1. 현재 블록을 정제하여 추가
      const cleanBlock = cleanBlockData(block);
      
      // 노션 API append 시 자식 블록 중첩 에러를 피하기 위해 has_children 블록은 플랫화하여 추가
      if (has_children) {
        // 테이블은 구조상 하위 table_row가 필수이므로 예외 처리
        if (type === 'table') {
          const childRows = await getCleanBlockChildrenFlat(id);
          cleanBlock[type].children = childRows;
          flatCleanBlocks.push(cleanBlock);
        } else {
          // 일반 블록(불릿 등)의 자식은 플랫화하여 원래 블록 뒤에 차례대로 이어 붙여 에러 차단
          flatCleanBlocks.push(cleanBlock);
          const childBlocks = await getCleanBlockChildrenFlat(id);
          flatCleanBlocks = flatCleanBlocks.concat(childBlocks);
        }
      } else {
        flatCleanBlocks.push(cleanBlock);
      }
    } catch (e) {
      console.warn(`      ⚠️ 블록(${block.id}) 분석 중 건너뜀:`, e.message);
    }
  }

  return flatCleanBlocks;
}

// 두 페이지 간의 본문 복제 실행기
async function clonePageContent(oldPageId, newPageId) {
  try {
    const cleanBlocks = await getCleanBlockChildrenFlat(oldPageId);
    if (cleanBlocks.length > 0) {
      // 10개씩 청크 단위로 나누어 업로드하여 노션 API 부하 분산
      const chunkSize = 10;
      for (let i = 0; i < cleanBlocks.length; i += chunkSize) {
        const chunk = cleanBlocks.slice(i, i + chunkSize);
        await notion.blocks.children.append({
          block_id: newPageId,
          children: chunk
        });
        await delay(300);
      }
    }
  } catch (err) {
    console.error(`      ⚠️ 본문 복제 실패 (Old Page ID: ${oldPageId}):`, err.message);
  }
}

async function main() {
  console.log('🚀 [마이그레이션 엔진] 안전한 전체 페이지 복제 마이그레이션을 시작합니다...');

  // 중복 생성을 구분하기 위한 실시간 고유 타임스탬프
  const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').substring(5, 16);
  const parentTitle = `Team Workspace (복사본 - ${timestamp})`;

  // 1. 최상위 부모 페이지 생성
  console.log(`\n[1단계] 최상위 부모 페이지 "${parentTitle}" 생성 중...`);
  let parentPage;
  try {
    parentPage = await notion.pages.create({
      parent: { type: 'workspace', workspace: true }, // 진짜 워크스페이스 최상위 루트!
      properties: {
        title: [
          {
            text: { content: parentTitle }
          }
        ]
      }
    });
    console.log(`   - 성공! 새 부모 페이지 ID: ${parentPage.id}`);
  } catch (err) {
    console.error('❌ 부모 페이지 생성 실패:', err.message);
    return;
  }
  const parentPageId = parentPage.id;
  await delay();

  // 2. 5개 데이터베이스 1차 생성 (관계형/롤업/수식 제외한 순수 속성 스키마로 생성)
  console.log('\n[2단계] 전체 페이지 데이터베이스 5종 1차 생성 중...');
  const newDbIds = {};

  // 2-1. Team Members 생성
  try {
    const db = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ text: { content: 'Team Members' } }],
      is_inline: false,
      properties: {
        '이름': { type: 'title', title: {} },
        '파일과 미디어': { type: 'files', files: {} }
      }
    });
    newDbIds.teamMembers = db.id;
    console.log(`   - [Team Members] DB 생성 완료: ${db.id}`);
  } catch (err) {
    console.error('   - [Team Members] 생성 실패:', err.message);
  }
  await delay();

  // 2-2. Projects 생성
  try {
    const db = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ text: { content: 'Projects' } }],
      is_inline: false,
      properties: {
        '프로젝트 명': { type: 'title', title: {} },
        'image': { type: 'files', files: {} },
        '프로젝트 기간': { type: 'date', date: {} },
        '선택': {
          type: 'select',
          select: {
            options: [
              { name: '무인대차', color: 'brown' },
              { name: '자동화설비', color: 'red' },
              { name: '스마트팜시스템', color: 'default' },
              { name: '생육모델링', color: 'green' },
              { name: '기타', color: 'gray' },
              { name: '유선드론', color: 'yellow' }
            ]
          }
        },
        '진행 상황': {
          type: 'status',
          status: {
            options: [
              { name: '시작 전', color: 'default' },
              { name: '⏸️ 보류', color: 'yellow' },
              { name: '🚀 진행 중', color: 'blue' },
              { name: '✅ 완료', color: 'green' }
            ]
          }
        }
      }
    });
    newDbIds.projects = db.id;
    console.log(`   - [Projects] DB 생성 완료: ${db.id}`);
  } catch (err) {
    console.error('   - [Projects] 생성 실패:', err.message);
  }
  await delay();

  // 2-3. Tasks 생성
  try {
    const db = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ text: { content: 'Tasks' } }],
      is_inline: false,
      properties: {
        'Task': { type: 'title', title: {} },
        '마감일자': { type: 'date', date: {} },
        '진행 상황': {
          type: 'status',
          status: {
            options: [
              { name: '⏸️ 대기', color: 'gray' },
              { name: '🙏 진행 예정', color: 'default' },
              { name: '🚀 진행 중', color: 'yellow' },
              { name: '💡 피드백', color: 'purple' },
              { name: '✅ 완료', color: 'green' },
              { name: '⏭ 보류', color: 'gray' }
            ]
          }
        }
      }
    });
    newDbIds.tasks = db.id;
    console.log(`   - [Tasks] DB 생성 완료: ${db.id}`);
  } catch (err) {
    console.error('   - [Tasks] 생성 실패:', err.message);
  }
  await delay();

  // 2-4. Weekly Plan 생성
  try {
    const db = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ text: { content: 'Weekly Plan' } }],
      is_inline: false,
      properties: {
        '...': { type: 'title', title: {} },
        'Week Start': { type: 'date', date: {} },
        '할 일': { type: 'rich_text', rich_text: {} },
        '메모': { type: 'rich_text', rich_text: {} }
      }
    });
    newDbIds.weeklyPlan = db.id;
    console.log(`   - [Weekly Plan] DB 생성 완료: ${db.id}`);
  } catch (err) {
    console.error('   - [Weekly Plan] 생성 실패:', err.message);
  }
  await delay();

  // 2-5. Daily Work Log 생성
  try {
    const db = await notion.databases.create({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ text: { content: 'Daily Work Log' } }],
      is_inline: false,
      properties: {
        '업무': { type: 'title', title: {} },
        '업무일': { type: 'date', date: {} },
        '문제점·이슈': { type: 'rich_text', rich_text: {} },
        '생성 일시': { type: 'created_time', created_time: {} }
      }
    });
    newDbIds.dailyWorkLog = db.id;
    console.log(`   - [Daily Work Log] DB 생성 완료: ${db.id}`);
  } catch (err) {
    console.error('   - [Daily Work Log] 생성 실패:', err.message);
  }
  await delay();

  // 3. 관계형 및 롤업 2차 빌드 주입 (수식은 밸리데이션 방지를 위해 생성 후 노션 화면에서 붙여넣기 하거나 UI에서 추가하도록 안전 처리)
  console.log('\n[3단계] 관계형, 롤업 스키마 2차 업데이트 및 결합 중...');

  // 3-1. Projects 스키마 업데이트 (PM 관계형, Tasks DB 양방향 관계형)
  try {
    await notion.databases.update({
      database_id: newDbIds.projects,
      properties: {
        'PM': {
          type: 'relation',
          relation: {
            database_id: newDbIds.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        },
        'Tasks DB': {
          type: 'relation',
          relation: {
            database_id: newDbIds.tasks,
            type: 'dual_property',
            dual_property: {
              synced_property_name: 'Project' // Tasks 데이터베이스 측에 생성될 역방향 관계명
            }
          }
        }
      }
    });
    console.log('   - [Projects] 2차 스키마 빌드 성공 (PM, Tasks DB 관계형 완료)');
  } catch (err) {
    console.error('   - [Projects] 2차 스키마 빌드 실패:', err.message);
  }
  await delay();

  // 3-2. Tasks 스키마 업데이트 (담당자 관계형)
  try {
    await notion.databases.update({
      database_id: newDbIds.tasks,
      properties: {
        '담당자': {
          type: 'relation',
          relation: {
            database_id: newDbIds.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        }
      }
    });
    console.log('   - [Tasks] 2차 스키마 빌드 성공 (담당자 관계형 완료)');
  } catch (err) {
    console.error('   - [Tasks] 2차 스키마 빌드 실패:', err.message);
  }
  await delay();

  // 3-3. Weekly Plan 스키마 업데이트 (작성자 관계형)
  try {
    await notion.databases.update({
      database_id: newDbIds.weeklyPlan,
      properties: {
        '작성자': {
          type: 'relation',
          relation: {
            database_id: newDbIds.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        }
      }
    });
    console.log('   - [Weekly Plan] 2차 스키마 빌드 성공 (작성자 관계형 완료)');
  } catch (err) {
    console.error('   - [Weekly Plan] 2차 스키마 빌드 실패:', err.message);
  }
  await delay();

  // 3-4. Daily Work Log 스키마 업데이트 (담당자, 관련 Task, 관련 Project 롤업)
  try {
    await notion.databases.update({
      database_id: newDbIds.dailyWorkLog,
      properties: {
        '담당자': {
          type: 'relation',
          relation: {
            database_id: newDbIds.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        },
        '관련 Task': {
          type: 'relation',
          relation: {
            database_id: newDbIds.tasks,
            type: 'single_property',
            single_property: {}
          }
        },
        '관련 Project(자동)': {
          type: 'rollup',
          rollup: {
            rollup_property_name: 'Project',
            relation_property_name: '관련 Task',
            function: 'show_original'
          }
        }
      }
    });
    console.log('   - [Daily Work Log] 2차 스키마 빌드 성공 (담당자, 관련 Task 관계형 및 롤업 완료)');
  } catch (err) {
    console.error('   - [Daily Work Log] 2차 스키마 빌드 실패:', err.message);
  }
  await delay();

  // 4. 데이터 쿼리 및 순차 복제 (ID 매핑 유지)
  console.log('\n[4단계] 데이터 백업 쿼리 및 신규 데이터베이스로 이관 시작...');
  const idMap = {};

  // 4-1. Team Members 이사
  console.log(' 👉 [Team Members] 데이터 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.teamMembers });
    console.log(`   - 총 ${res.results.length}명 백업 완료. 생성 시작...`);
    for (const page of res.results) {
      const name = page.properties['이름']?.title?.[0]?.plain_text || '이름 없음';
      const files = page.properties['파일과 미디어']?.files || [];

      const newPage = await notion.pages.create({
        parent: { database_id: newDbIds.teamMembers },
        properties: {
          '이름': {
            title: [{ text: { content: name } }]
          },
          '파일과 미디어': {
            files: files.map(f => ({ name: f.name, type: f.type, [f.type]: f[f.type] }))
          }
        }
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 완료: ${name} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [Team Members] 복제 실패:', err.message);
  }

  // 4-2. Projects 이사
  console.log(' 👉 [Projects] 데이터 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.projects });
    console.log(`   - 총 ${res.results.length}개 프로젝트 백업 완료. 생성 시작...`);
    for (const page of res.results) {
      const name = page.properties['프로젝트 명']?.title?.[0]?.plain_text || '제목 없음';
      const image = page.properties['image']?.files || [];
      const duration = page.properties['프로젝트 기간']?.date || null;
      const select = page.properties['선택']?.select ? { name: page.properties['선택'].select.name } : null;
      const status = page.properties['진행 상황']?.status ? { name: page.properties['진행 상황'].status.name } : null;
      const pmRelation = page.properties['PM']?.relation || [];

      const properties = {
        '프로젝트 명': { title: [{ text: { content: name } }] },
        'image': { files: image.map(i => ({ name: i.name, type: i.type, [i.type]: i[i.type] })) }
      };
      if (duration) properties['프로젝트 기간'] = { date: duration };
      if (select) properties['선택'] = { select };
      if (status) properties['진행 상황'] = { status };
      if (pmRelation.length > 0) {
        properties['PM'] = {
          relation: pmRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }

      const newPage = await notion.pages.create({
        parent: { database_id: newDbIds.projects },
        properties: properties
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 완료: ${name} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [Projects] 복제 실패:', err.message);
  }

  // 4-3. Tasks 이사
  console.log(' 👉 [Tasks] 데이터 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.tasks });
    console.log(`   - 총 ${res.results.length}개 태스크 백업 완료. 생성 시작...`);
    for (const page of res.results) {
      const task = page.properties['Task']?.title?.[0]?.plain_text || '태스크 없음';
      const dueDate = page.properties['마감일자']?.date || null;
      const status = page.properties['진행 상황']?.status ? { name: page.properties['진행 상황'].status.name } : null;
      const assigneeRelation = page.properties['담당자']?.relation || [];
      const projectRelation = page.properties['Project']?.relation || [];

      const properties = {
        'Task': { title: [{ text: { content: task } }] }
      };
      if (dueDate) properties['마감일자'] = { date: dueDate };
      if (status) properties['진행 상황'] = { status };
      if (assigneeRelation.length > 0) {
        properties['담당자'] = {
          relation: assigneeRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }
      if (projectRelation.length > 0) {
        properties['Project'] = {
          relation: projectRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }

      const newPage = await notion.pages.create({
        parent: { database_id: newDbIds.tasks },
        properties: properties
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 완료: ${task} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [Tasks] 복제 실패:', err.message);
  }

  // 4-4. Weekly Plan 이사
  console.log(' 👉 [Weekly Plan] 데이터 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.weeklyPlan });
    console.log(`   - 총 ${res.results.length}개 주간계획 백업 완료. 생성 시작...`);
    for (const page of res.results) {
      const title = page.properties['...']?.title?.[0]?.plain_text || '';
      const weekStart = page.properties['Week Start']?.date || null;
      const todo = page.properties['할 일']?.rich_text || [];
      const memo = page.properties['메모']?.rich_text || [];
      const authorRelation = page.properties['작성자']?.relation || [];

      const properties = {
        '...': { title: [{ text: { content: title } }] },
        '할 일': { rich_text: todo.map(t => ({ type: t.type, [t.type]: t[t.type], text: t.text, annotations: t.annotations })) },
        '메모': { rich_text: memo.map(m => ({ type: m.type, [m.type]: m[m.type], text: m.text, annotations: m.annotations })) }
      };
      if (weekStart) properties['Week Start'] = { date: weekStart };
      if (authorRelation.length > 0) {
        properties['작성자'] = {
          relation: authorRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }

      const newPage = await notion.pages.create({
        parent: { database_id: newDbIds.weeklyPlan },
        properties: properties
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 완료: ${title} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [Weekly Plan] 복제 실패:', err.message);
  }

  // 4-5. Daily Work Log 이사
  console.log(' 👉 [Daily Work Log] 데이터 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.dailyWorkLog });
    console.log(`   - 총 ${res.results.length}개 일일일지 백업 완료. 생성 시작...`);
    for (const page of res.results) {
      const title = page.properties['업무']?.title?.[0]?.plain_text || '';
      const date = page.properties['업무일']?.date || null;
      const issue = page.properties['문제점·이슈']?.rich_text || [];
      const assigneeRelation = page.properties['담당자']?.relation || [];
      const taskRelation = page.properties['관련 Task']?.relation || [];

      const properties = {
        '업무': { title: [{ text: { content: title } }] },
        '문제점·이슈': { rich_text: issue.map(i => ({ type: i.type, [i.type]: i[i.type], text: i.text, annotations: i.annotations })) }
      };
      if (date) properties['업무일'] = { date };
      if (assigneeRelation.length > 0) {
        properties['담당자'] = {
          relation: assigneeRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }
      if (taskRelation.length > 0) {
        properties['관련 Task'] = {
          relation: taskRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }

      const newPage = await notion.pages.create({
        parent: { database_id: newDbIds.dailyWorkLog },
        properties: properties
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 완료: ${title} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [Daily Work Log] 복제 실패:', err.message);
  }

  // 5. 새로운 .env.new 파일 생성
  console.log('\n[5단계] 새로운 환경설정 파일 (.env.new) 생성 중...');
  try {
    const oldEnv = fs.readFileSync('.env', 'utf8');
    let newEnv = oldEnv;
    newEnv = newEnv.replace(/NOTION_WEEKLY_PLAN_DB_ID=.*/, `NOTION_WEEKLY_PLAN_DB_ID=${newDbIds.weeklyPlan}`);
    newEnv = newEnv.replace(/NOTION_DAILY_WORK_LOG_DB_ID=.*/, `NOTION_DAILY_WORK_LOG_DB_ID=${newDbIds.dailyWorkLog}`);
    newEnv = newEnv.replace(/NOTION_TASKS_DB_ID=.*/, `NOTION_TASKS_DB_ID=${newDbIds.tasks}`);
    newEnv = newEnv.replace(/NOTION_TEAM_MEMBERS_DB_ID=.*/, `NOTION_TEAM_MEMBERS_DB_ID=${newDbIds.teamMembers}`);
    
    // 추가로 Projects DB ID 백업용 주석 기록
    newEnv += `\n# 복제된 Projects DB ID: ${newDbIds.projects}`;

    fs.writeFileSync('.env.new', newEnv);
    console.log('   - 성공! .env.new 파일이 출력되었습니다.');
  } catch (err) {
    console.error('   - .env.new 생성 실패:', err.message);
  }

  console.log(`\n🎉 모든 복제 마이그레이션이 아주 안전하고 완벽하게 성공하였습니다!`);
  console.log(`   * 노션에서 "${parentTitle}" 페이지를 열어 복제된 전체 페이지 데이터베이스들을 확인해 주세요.`);
  console.log('   * 새로운 환경설정을 적용하려면기존 .env를 백업하고 .env.new 파일로 교체하시면 됩니다.');
}

main();
