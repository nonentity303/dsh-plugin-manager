import { copyFileSync } from 'fs';

try {
  copyFileSync(
    'dsh-plugin-manager-pro-0.6.9.tgz',
    'dsh-plugin-manager-pro-0.6.9.1.tgz'
  );
  console.log('Package renamed successfully to 0.6.9.1');
} catch (error) {
  console.error('Error renaming package:', error.message);
}