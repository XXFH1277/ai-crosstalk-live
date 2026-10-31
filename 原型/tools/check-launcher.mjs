import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.platform==='win32'){
  process.stdout.write(execFileSync('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('./check-launcher.ps1',import.meta.url))],{encoding:'utf8',timeout:30000}));
}else console.log('SKIP Windows 一键入口检查');
