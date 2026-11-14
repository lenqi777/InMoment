'use strict';
// Explicit development-only copy from the installed, pinned package. No network.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),version='0.19.1';
const source=path.dirname(require.resolve('katex/package.json'));
const metadata=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
if(metadata.version!==version)throw new Error('Install the pinned KaTeX '+version+' before syncing local math assets.');
const destination=path.join(root,'src/vendor/katex');fs.mkdirSync(path.join(destination,'fonts'),{recursive:true});
const assets=[['dist/katex.min.js','katex.min.js'],['dist/katex.min.css','katex.min.css'],['LICENSE','LICENSE.txt'],...fs.readdirSync(path.join(source,'dist/fonts')).filter(name=>/\.(?:woff2?|ttf)$/u.test(name)).sort().map(name=>['dist/fonts/'+name,'fonts/'+name])];
const files=assets.map(([input,output])=>{const bytes=fs.readFileSync(path.join(source,input));fs.writeFileSync(path.join(destination,output),bytes);return {path:output,upstreamPath:input,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({name:'katex',version,license:'MIT',source:'https://github.com/KaTeX/KaTeX/tree/v'+version,package:'https://registry.npmjs.org/katex/-/katex-'+version+'.tgz',files},null,2)+'\n');
console.log(JSON.stringify({version,files:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes,0)}));
