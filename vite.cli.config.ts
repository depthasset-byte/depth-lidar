// 명령줄 도구(depth-lidar) 묶음: Node에서 도는 파일 하나(dist-cli/depth-lidar.cjs)로 만든다.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/cli/main.ts',
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'depth-lidar.cjs', codeSplitting: false },
    },
  },
  // 실행할 때 node_modules가 없어도 되도록 의존 모듈을 모두 묶는다.
  ssr: { noExternal: true },
} as never);
