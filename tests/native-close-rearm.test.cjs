'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{spawnSync}=require('node:child_process');
const enabled=process.platform==='win32'&&process.env.INMOMENT_NATIVE_CLOSE_TEST==='1';
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
test('native close restores its owned source and rearms three holds without any extra left click',{skip:enabled?false:'Explicit own-window native proof: INMOMENT_NATIVE_CLOSE_TEST=1',timeout:25000},t=>{
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(__dirname,'.tmp-native-close-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const windows=process.env.WINDIR||'C:/Windows',framework=path.join(windows,'Microsoft.NET/Framework64/v4.0.30319'),gac=path.join(windows,'Microsoft.NET/assembly/GAC_MSIL');
 const references=['System.Speech','UIAutomationClient','UIAutomationTypes','WindowsBase'].map(name=>{const directory=path.join(gac,name),version=fs.readdirSync(directory).find(value=>value.startsWith('v4.0_'));return'/reference:'+path.join(directory,version,name+'.dll')});
 const binary=path.join(temp,'CloseRearm.NativeTest.exe');const compile=spawnSync(path.join(framework,'csc.exe'),['/nologo','/target:exe','/platform:x64','/define:INMOMENT_NATIVE_INPUT_TEST','/main:InMoment.Native.CloseRearmHarness','/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',...references,'/out:'+binary,path.join(root,'native/InMoment.Native.cs'),path.join(__dirname,'fixtures/native-close-rearm.cs')],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.ifError(compile.error);assert.equal(compile.status,0,compile.stdout+compile.stderr);
 const output=path.join(temp,'result.json'),errors=path.join(temp,'stderr.txt');const command=`$testProcess = Start-Process -FilePath ${quote(binary)} -WindowStyle Normal -PassThru -Wait -RedirectStandardOutput ${quote(output)} -RedirectStandardError ${quote(errors)}\nexit $testProcess.ExitCode`;
 const run=spawnSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(run.error);const result=JSON.parse(fs.readFileSync(output,'utf8').replace(/^\uFEFF/u,''));assert.equal(run.status,0,result.error);assert.equal(result.ok,true,result.error);assert.equal(result.cycles,3);assert.equal(result.starts,3);assert.equal(result.ends,3);assert.equal(result.leftClicksAfterInitialFocus,0);assert.equal(result.microphoneTest,'not-run');assert.equal(result.screenshotTest,'not-run');assert.equal(fs.readFileSync(errors,'utf8'),'');
});
