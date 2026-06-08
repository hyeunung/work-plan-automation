const { Client } = require('@notionhq/client');
const config = require('./src/config');
require('dotenv').config();

const notion = new Client({ auth: config.notion.token });

async function run() {
  const pageId = '36cc640c-cca4-80ce-a667-e93c9de3acd0';
  const page = await notion.pages.retrieve({ page_id: pageId });
  console.log('Raw page properties:', JSON.stringify(page.properties, null, 2));
}

run().catch(console.error);
