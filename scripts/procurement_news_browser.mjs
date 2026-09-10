// Fixed public sources only. No persistent browser profile or procurement input.
import { chromium } from 'playwright';
const sources = [['商务部','https://trb.mofcom.gov.cn/'],['生意社','https://www.100ppi.com/news/list-14--1.html'],['隆众资讯','https://www.oilchem.net/1/32458/']];
const articles = [/^https:\/\/trb\.mofcom\.gov\.cn\/[^?#]+\/art_\w+\.html$/, /^https:\/\/www\.100ppi\.com\/news\/detail-\d{8}-\d+\.html$/, /^https:\/\/www\.oilchem\.net\/\d{2}-\d{4}-\d{2}-[a-f0-9]+\.html$/];
let browser;
let stopping = false;
async function stop(){stopping=true; await browser?.close().catch(()=>{}); process.exit(0);}
process.stdin.on('data',stop);
process.stdin.on('end',stop);
process.on('SIGTERM',stop);
try {
  browser = await chromium.launch({headless:true});
  const results = await Promise.all(sources.map(async ([name,url],index) => {
    for(let attempt=0;attempt<2;attempt++){
      const context=await browser.newContext();
      try {
        const page=await context.newPage();
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
        await page.waitForSelector('li a',{timeout:10000});
        const rows=await page.locator('li a:visible').evaluateAll(links=>links.map(a=>({url:a.href,title:a.getAttribute('title')||a.textContent,date:(a.closest('li').textContent.replace(/\s+/g,' ').match(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/)||[])[0]||''})));
        if(!rows.some(row=>articles[index].test(row.url) && row.title?.trim() && row.date && !Number.isNaN(Date.parse(row.date.replace(' ','T'))) && new Date(`${row.date.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10)===row.date.slice(0,10))) throw new Error('No dated news');
        return {name,rows,error:null};
      } catch(error){if(attempt===1)return {name,rows:[],error:error instanceof Error?error.name:'FetchError'};}
      finally{await context.close();}
    }
  }));
  if(!stopping)process.stdout.write(JSON.stringify(results));
}catch{process.stdout.write(JSON.stringify(sources.map(([name])=>({name,rows:[],error:'BrowserUnavailable'}))));}
finally{await browser?.close().catch(()=>{});process.stdin.pause();}
