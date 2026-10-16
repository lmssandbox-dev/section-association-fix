'use strict';
const path=require('node:path');
const {build}=require('esbuild');
build({entryPoints:[path.join(__dirname,'../src/ui/app.mjs')],bundle:true,minify:true,format:'esm',target:['es2022'],outfile:path.join(__dirname,'../public/assets/app.js'),legalComments:'eof'}).catch(()=>{process.exitCode=1;});
