import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

// 读取package.json
const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));
const currentVersion = packageJson.version;

console.log(`当前版本: ${currentVersion}`);
console.log('正在打包...');

try {
  // 执行npm pack命令
  execSync('npm pack', { stdio: 'inherit', cwd: './' });
  console.log('打包完成！');
  
  // 查找生成的tgz文件
  const files = readFileSync('./package-lock.json', 'utf8');
  const packageName = packageJson.name;
  const expectedFile = `${packageName}-${currentVersion}.tgz`;
  
  console.log(`生成的包文件: ${expectedFile}`);
  
} catch (error) {
  console.error('打包失败:', error.message);
  process.exit(1);
}