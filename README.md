# Depth Lidar

아르텍 레이(Ray) 라이다 스캔 원본을 읽어 정합, 퓨전, 단순화, 텍스처 굽기, 납품 규격 맞춤까지 처리하는 도구입니다. 화면 프로그램(Electron)과 명령줄(CLI)이 함께 들어 있습니다.

## 명령줄 한 번에 처리

```
node dist-cli/depth-lidar.cjs pipeline <project.artec> --project 1 --name <라이다명> --out <작업폴더> --step 16 --voxel 60
```

단계: 스캔 불러오기, 자동 정합, 퓨전, 단순화, 텍스처 굽기, 규격 맞춤과 검사.

- `--step` 작을수록 점을 많이 씁니다(납품용은 1~4).
- `--voxel` 퓨전 격자 크기(mm).
- `--size` 텍스처 한 변 크기(기본 8192).

규격 맞춤 단계는 별도의 `lidar_finalize.py`, `lidar_check.py` 도구가 필요합니다(환경변수 `DEPTH_LIDAR_TOOLS`, `DEPTH_LIDAR_PYTHON`로 위치 지정).

텍스처 굽기는 이 프로그램의 자체 방식이며 아르텍 스튜디오의 알고리즘이 아닙니다.

## 빌드

```
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

실행 파일은 `release\Depth Lidar-win32-x64\Depth Lidar.exe`에 만들어집니다.