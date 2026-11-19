// まちの顧客台帳（machino-crm.web.app）の index.html だけを差し替えて公開する。
// 公開中のほかのファイル（manifest.json・icon.png など）や設定（headers など）は、いま公開中のものをそのまま引き継ぐ。
// 使い方: node deploy.mjs <新しい index.html> <公開中と比べてよい過去の版が入ったフォルダ>
import fs from "node:fs";import path from "node:path";import zlib from "node:zlib";import crypto from "node:crypto";
import {GoogleAuth} from "google-auth-library";
const [,,NEW,OKDIR]=process.argv;const SITE=process.env.SITE||"machino-crm";
const API="https://firebasehosting.googleapis.com/v1beta1/";
const auth=new GoogleAuth({scopes:["https://www.googleapis.com/auth/cloud-platform"]});const cl=await auth.getClient();
async function call(url,opt={}){const r=await cl.request({url:url.startsWith("http")?url:API+url,...opt});return r.data}
const norm=s=>s.replace(/\r\n/g,"\n");
// 1) 公開中の index.html が、このリポジトリに記録したどれかの版と同じか確かめる（ほかで直された版を上書きしないため）
const live=norm(await (await fetch(`https://${SITE}.web.app/index.html?nocache=${Date.now()}`,{cache:"no-store"})).text());
const next=fs.readFileSync(NEW,"utf8");
if(live===norm(next)){console.log("公開中の画面はすでに最新です。何もしません。");process.exit(0)}
const oks=fs.readdirSync(OKDIR).map(f=>norm(fs.readFileSync(path.join(OKDIR,f),"utf8")));
if(!oks.includes(live)){fs.writeFileSync(path.join(process.env.RUNNER_TEMP||".","live.html"),live);console.log("::error::公開中の index.html が、このリポジトリのどの版とも違います（ほかの所で直された可能性があります）。上書きしないよう止めました。");process.exit(1)}
// 2) いま公開中の版のファイルと設定を読む
const rel=(await call(`sites/${SITE}/releases?pageSize=1`)).releases?.[0];if(!rel?.version?.name)throw new Error("公開中の版が見つかりません");
const cur=rel.version;const files={};let tok="";
do{const d=await call(`${cur.name}/files?pageSize=1000${tok?"&pageToken="+tok:""}`);for(const f of d.files||[])files[f.path]=f.hash;tok=d.nextPageToken||""}while(tok);
console.log("公開中の版:",cur.name,"ファイル:",Object.keys(files).join(", "));
if(!files["/index.html"])throw new Error("公開中の版に /index.html がありません");
// 3) 新しい版を作り、index.html だけ差し替える
const gz=zlib.gzipSync(Buffer.from(next,"utf8"),{level:9});const hash=crypto.createHash("sha256").update(gz).digest("hex");
files["/index.html"]=hash;
const ver=await call(`sites/${SITE}/versions`,{method:"POST",data:{config:cur.config||{}}});
const pop=await call(`${ver.name}:populateFiles`,{method:"POST",data:{files}});
if((pop.uploadRequiredHashes||[]).includes(hash))await cl.request({url:`${pop.uploadUrl}/${hash}`,method:"POST",headers:{"Content-Type":"application/octet-stream"},body:gz});
const miss=(pop.uploadRequiredHashes||[]).filter(h=>h!==hash);if(miss.length)throw new Error("引き継げないファイルがありました: "+miss.join(","));
await call(`${ver.name}?update_mask=status`,{method:"PATCH",data:{status:"FINALIZED"}});
await call(`sites/${SITE}/releases?versionName=${encodeURIComponent(ver.name)}`,{method:"POST",data:{message:(process.env.MSG||"index.html を更新").split("\n")[0].slice(0,200)}});
console.log("公開しました:",ver.name);
// 4) 反映を確かめる
for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,6000));const t=norm(await (await fetch(`https://${SITE}.web.app/index.html?v=${Date.now()}`,{cache:"no-store"})).text());if(t===norm(next)){console.log("公開中の画面が新しくなったことを確認しました。");process.exit(0)}}
console.log("::warning::公開はしましたが、まだ古い画面が返ってきます（数分で切り替わるはずです）。");
