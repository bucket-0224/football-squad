# EC2 배포 (CI 자동 배포)

`main` 브랜치에 push되면 `.github/workflows/deploy.yml`이 SSH로 EC2에 접속해
`deploy/deploy.sh`를 실행합니다 (`git reset --hard` → `npm ci` → `pm2 reload`).
backend(3000)와 frontend(8080)를 같은 인스턴스에서 pm2로 관리합니다
(`ecosystem.config.js`).

## 1. EC2 최초 설정 (한 번만)

```bash
# Node 18+, git, pm2
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -   # Amazon Linux
sudo yum install -y nodejs git
sudo npm install -g pm2

# 이 워크플로 전용 SSH 배포 키 생성 (레포 클론/pull용, GitHub 계정 키와 별개)
ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -N ""
cat ~/.ssh/deploy_key.pub   # 이 공개키를 GitHub repo Settings > Deploy keys 에 등록 (read-only)

# ~/.ssh/config 에 등록해서 git이 이 키를 쓰도록
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/deploy_key
  IdentitiesOnly yes
EOF

git clone git@github.com:bucket-0224/football-squad.git ~/football-squad
cd ~/football-squad/backend && npm ci --omit=dev
```

레포가 public이면 deploy key 없이 `https://github.com/...` 로 그냥 clone해도 됩니다.

## 2. 보안 그룹

인바운드에 TCP 3000(backend), 8080(frontend) 을 열어주세요 (0.0.0.0/0 또는 필요한 IP만).

## 3. GitHub repo secrets (Settings > Secrets and variables > Actions)

| Secret | 값 |
|---|---|
| `EC2_HOST` | EC2 퍼블릭 IP 또는 도메인 |
| `EC2_USER` | `ec2-user` |
| `EC2_SSH_KEY` | GitHub Actions가 EC2에 로그인할 SSH **개인키** 전체 내용 (`~/.ssh/authorized_keys`에 대응하는 키 — 위 deploy_key와는 별개로, 이 EC2 계정에 로그인 가능한 키를 사용) |
| `EC2_DEPLOY_PATH` | `/home/ec2-user/football-squad` |

`EC2_SSH_KEY`로 등록할 키의 공개키 쌍을 EC2 인스턴스의 `~/.ssh/authorized_keys`에 추가해야
GitHub Actions가 로그인할 수 있습니다 (인스턴스 생성 시 받은 `.pem`을 그대로 써도 되고,
전용 키를 새로 만들어 추가해도 됩니다).

## 4. 확인

```bash
curl http://<EC2_HOST>:3000/api/season   # backend
curl http://<EC2_HOST>:8080/             # frontend
```

프론트엔드는 `frontend/config.js`가 현재 접속한 hostname을 그대로 백엔드 주소로
쓰도록 되어 있어(같은 호스트, 3000 포트 고정) 로컬/EC2 모두 코드 수정 없이 동작합니다.
