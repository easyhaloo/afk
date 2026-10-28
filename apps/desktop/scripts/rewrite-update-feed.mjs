import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const directory=process.argv[2], repository=process.env.GITHUB_REPOSITORY, tag=process.env.RELEASE_TAG;
if(!directory||!repository||!tag)throw new Error("Expected directory, GITHUB_REPOSITORY and RELEASE_TAG");
for(const name of ["latest.yml","latest-mac.yml","latest-linux.yml"]){
 let content; try{content=readFileSync(path.join(directory,name),"utf8")}catch{continue}
 content=content.replace(/^(\s*-\s*url:\s*)([^\r\n]+)$/gm,(_match,prefix,value)=>{
  const asset=value.trim().replace(/^["']|["']$/g,"");
  if (/^https?:\/\//i.test(asset)) return prefix + asset;
  const encodedAsset = asset.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return prefix + `https://github.com/${repository}/releases/download/${tag}/${encodedAsset}`;
 });
 writeFileSync(path.join(directory,name),content);
}
