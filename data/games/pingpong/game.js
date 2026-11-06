window.RehabGames = window.RehabGames || {};

window.RehabGames['pingpong'] = class PingPongGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        
        // Фізика та стан
        this.calibMin = -20;
        this.calibMax = 20;
        this.consecutiveHits = 0;
        
        // Розміри Canvas
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;
        
        // Ігрові об'єкти
        this.paddleW = 10;
        this.paddleH = 60;
        this.ballSize = 15;
        this.playerY = 0;
        this.botY = 0;
        this.ballX = 0;
        this.ballY = 0;
        this.ballVX = 0;
        this.ballVY = 0;
        
        this.currentBallSpeed = 0;
        this.baseSpeedRatio = 0.012; // Базова швидкість відносно ширини екрану
        this.maxSpeedRatio = 0.025;  // Максимальна швидкість
        
        this.botTargetY = 0;
        this.botReactionDelayTimer = 0;
    }
    
    init(canvas, options) {
        options = options || {};
        this.ctx = canvas.getContext("2d");
        this.calibMin = Number.isFinite(options.calibMin) ? options.calibMin : -20;
        this.calibMax = Number.isFinite(options.calibMax) ? options.calibMax : 20;
        if (this.calibMax <= this.calibMin) {
            this.calibMin = -20;
            this.calibMax = 20;
        }
        this.consecutiveHits = 0;
        
        this.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
        this.resetBall();
        this.playerY = this.height / 2 - this.paddleH / 2;
        this.botY = this.height / 2 - this.paddleH / 2;
        
        this.updateHUD("Очікування");
    }
    
    resize(width, height) {
        this.width = Math.max(1, Number(width) || 1);
        this.height = Math.max(1, Number(height) || 1);
        
        this.paddleW = Math.max(10, this.width * 0.015);
        this.paddleH = Math.max(60, this.height * 0.25);
        this.ballSize = Math.max(15, Math.min(35, this.width * 0.03));
        
        // Запобігаємо багам швидкості при зміні орієнтації пристрою / зміні розміру вікна
        if (this.currentBallSpeed > 0) {
            let speedProgress = this.consecutiveHits * 0.0005; 
            this.currentBallSpeed = this.width * Math.min(this.baseSpeedRatio + speedProgress, this.maxSpeedRatio);
            
            // Нормалізуємо вектор швидкості
            let currentVelocity = Math.sqrt(this.ballVX ** 2 + this.ballVY ** 2);
            if (currentVelocity > 0) {
                this.ballVX = (this.ballVX / currentVelocity) * this.currentBallSpeed;
                this.ballVY = (this.ballVY / currentVelocity) * this.currentBallSpeed;
            }
        }
    }
    
    resetBall() {
        this.ballX = this.width / 2;
        this.ballY = this.height / 2;
        this.currentBallSpeed = this.width * this.baseSpeedRatio; 
        
        let angle = (Math.random() * Math.PI / 4) - Math.PI / 8; 
        let direction = Math.random() > 0.5 ? 1 : -1;
        this.ballVX = this.currentBallSpeed * Math.cos(angle) * direction;
        this.ballVY = this.currentBallSpeed * Math.sin(angle);
    }
    
    mapAngleToScreen(angle) {
        const safeAngle = Number.isFinite(angle) ? angle : (this.calibMin + this.calibMax) / 2;
        const clamped = Math.max(this.calibMin, Math.min(this.calibMax, safeAngle));
        const range = this.calibMax - this.calibMin;
        let normalized = range > 0 ? (clamped - this.calibMin) / range : 0.5;
        if (!Number.isFinite(normalized)) normalized = 0.5;
        return (1 - normalized) * (this.height - this.paddleH);
    }
    
    updateHUD(botStateMsg = null) {
        this.api.updateHUD("hudScore", `Успішні відбивання: ${this.consecutiveHits}`);
        if (botStateMsg) {
            this.api.updateHUD("hudBotState", `Стан: ${botStateMsg}`);
        }
    }
    
    syncCalibration() {
        this.api.updateCalibration(this.calibMin, this.calibMax);
    }
    
    update(currentAngle, dt) {
        // Запобігаємо стрибкам фізики при перемиканні вкладок браузера
        if (!Number.isFinite(dt) || dt < 0 || dt > 0.1) dt = 0.016;

        const input = arguments[2];
        const tare = Number.isFinite(input?.rollTare) ? input.rollTare : 0;
        const hasAngle = Number.isFinite(currentAngle) || Number.isFinite(input?.roll);
        const rawAngle = Number.isFinite(currentAngle) ? currentAngle : (Number.isFinite(input?.roll) ? input.roll : (this.calibMin + this.calibMax) / 2);
        const safeAngle = hasAngle && tare !== 0 ? (((rawAngle - tare + 180) % 360 + 360) % 360 - 180) : rawAngle;
        let boundsChanged = false;
        if (Number.isFinite(currentAngle)) {
            if (safeAngle > this.calibMax) { this.calibMax += (safeAngle - this.calibMax) * 0.05; boundsChanged = true; }
            if (safeAngle < this.calibMin) { this.calibMin -= (this.calibMin - safeAngle) * 0.05; boundsChanged = true; }
        }
        if (boundsChanged) {
            this.syncCalibration();
        }
        
        // Плавний рух ракетки гравця (Lerp)
        let targetPlayerY = this.mapAngleToScreen(safeAngle);
        if (Number.isFinite(targetPlayerY)) {
            this.playerY += (targetPlayerY - this.playerY) * 15 * dt;
        }
        
        // Обчислення наступної позиції м'яча (для Continuous Collision Detection)
        let nextBallX = this.ballX + this.ballVX * dt * 60;
        let nextBallY = this.ballY + this.ballVY * dt * 60;
        
        let maxBallSpeed = this.width * this.maxSpeedRatio;
        let maxBounceAngle = (5 * Math.PI) / 12; // 75 градусів
        
        // 1. Колізія з ракеткою Гравця (CCD: Перевірка проходження променю)
        if (this.ballVX < 0) {
            if (this.ballX >= this.paddleW && nextBallX <= this.paddleW) {
                // Точка перетину з площиною X ракетки
                let t = (this.ballX - this.paddleW) / (this.ballX - nextBallX);
                let crossY = this.ballY + (nextBallY - this.ballY) * t;
                
                if (crossY + this.ballSize >= this.playerY && crossY <= this.playerY + this.paddleH) {
                    nextBallX = this.paddleW;
                    nextBallY = crossY;
                    
                    let hitPos = (this.playerY + this.paddleH/2) - (crossY + this.ballSize/2);
                    let normalizedHit = Math.max(-1, Math.min(1, hitPos / (this.paddleH/2)));
                    let bounceAngle = normalizedHit * maxBounceAngle;
                    
                    this.currentBallSpeed = Math.min(this.currentBallSpeed * 1.05, maxBallSpeed);
                    this.ballVX = this.currentBallSpeed * Math.cos(bounceAngle);
                    this.ballVY = this.currentBallSpeed * -Math.sin(bounceAngle);
                    
                    this.consecutiveHits++;
                    this.updateHUD();
                }
            }
        } 
        // 2. Колізія з ракеткою Бота (CCD)
        else if (this.ballVX > 0) {
            let botEdgeX = this.width - this.paddleW - this.ballSize;
            if (this.ballX <= botEdgeX && nextBallX >= botEdgeX) {
                let t = (botEdgeX - this.ballX) / (nextBallX - this.ballX);
                let crossY = this.ballY + (nextBallY - this.ballY) * t;
                
                if (crossY + this.ballSize >= this.botY && crossY <= this.botY + this.paddleH) {
                    nextBallX = botEdgeX;
                    nextBallY = crossY;
                    
                    let hitPos = (this.botY + this.paddleH/2) - (crossY + this.ballSize/2);
                    let normalizedHit = Math.max(-1, Math.min(1, hitPos / (this.paddleH/2)));
                    let bounceAngle = normalizedHit * maxBounceAngle;
                    
                    this.currentBallSpeed = Math.min(this.currentBallSpeed * 1.05, maxBallSpeed);
                    this.ballVX = this.currentBallSpeed * -Math.cos(bounceAngle);
                    this.ballVY = this.currentBallSpeed * -Math.sin(bounceAngle);
                }
            }
        }
        
        // Колізія зі стінами (Верх / Низ)
        if (nextBallY <= 0) { 
            nextBallY = 0; 
            this.ballVY = Math.abs(this.ballVY); 
        } else if (nextBallY + this.ballSize >= this.height) { 
            nextBallY = this.height - this.ballSize; 
            this.ballVY = -Math.abs(this.ballVY); 
        }
        
        // Застосування фінальних координат
        this.ballX = nextBallX;
        this.ballY = nextBallY;
        
        // Smart Bot Логіка
        this.botReactionDelayTimer -= dt * 1000;
        if (this.botReactionDelayTimer <= 0 && this.ballVX > 0) {
            let delay = Math.max(100, 500 - (this.consecutiveHits * 40));
            let offset = Math.max(0, this.paddleH * 0.4 - (this.consecutiveHits * (this.paddleH * 0.05)));
            let maxSpeed = this.height * 0.006 + (this.consecutiveHits * 0.0005);
            
            let rawTargetY = this.ballY + (Math.random() * offset * 2 - offset) - this.paddleH / 2;
            
            // Виправлено: Бот тепер не намагається виїхати за межі екрану
            this.botTargetY = Math.max(0, Math.min(this.height - this.paddleH, rawTargetY));
            
            this.botReactionDelayTimer = delay;
            this.updateHUD(`Адаптація (${Math.round(delay)}мс, Шв: ${(maxSpeed/this.height*100).toFixed(1)})`);
        }
        
        // Плавний рух бота до своєї цілі
        if (this.ballVX > 0) {
            let botMaxSpeed = this.height * 0.006 + (this.consecutiveHits * 0.0005);
            let diff = this.botTargetY - this.botY;
            if (Math.abs(diff) > 2) {
                let step = Math.sign(diff) * Math.min(Math.abs(diff), botMaxSpeed * dt * 60);
                this.botY += step;
            }
        } else {
            // Коли м'яч летить до гравця, бот плавно повертається в центр
            let centerDiff = (this.height / 2 - this.paddleH / 2) - this.botY;
            this.botY += Math.sign(centerDiff) * Math.min(Math.abs(centerDiff), this.height * 0.002 * dt * 60);
        }
        this.botY = Math.max(0, Math.min(this.height - this.paddleH, this.botY));
        
        // Зараховуємо пропуск або рахунок
        if (this.ballX < -this.ballSize * 2) {
            this.consecutiveHits = Math.max(0, this.consecutiveHits - 2); 
            let range = this.calibMax - this.calibMin;
            this.calibMax -= range * 0.05;
            this.calibMin += range * 0.05;
            this.updateHUD("Пропуск!");
            this.syncCalibration();
            this.resetBall();
        } else if (this.ballX > this.width + this.ballSize * 2) {
            this.resetBall();
        }
    }
    
    draw(ctx) {
        ctx.save();
        // Очищення фону
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, this.width, this.height);
        
        // Центральна пунктирна лінія
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 15]);
        ctx.beginPath();
        ctx.moveTo(this.width / 2, 0);
        ctx.lineTo(this.width / 2, this.height);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Ракетка гравця
        ctx.fillStyle = '#00f2fe';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(0, this.playerY, this.paddleW, this.paddleH, 4); ctx.fill();
        } else {
            ctx.fillRect(0, this.playerY, this.paddleW, this.paddleH);
        }
        
        // Ракетка бота
        ctx.fillStyle = '#ff1744';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(this.width - this.paddleW, this.botY, this.paddleW, this.paddleH, 4); ctx.fill();
        } else {
            ctx.fillRect(this.width - this.paddleW, this.botY, this.paddleW, this.paddleH);
        }
        
        // М'яч
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ffffff';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(this.ballX, this.ballY, this.ballSize, this.ballSize, this.ballSize/2); ctx.fill();
        } else {
            ctx.fillRect(this.ballX, this.ballY, this.ballSize, this.ballSize);
        }
        ctx.shadowBlur = 0;
        ctx.restore();
    }
    
    stop() {
        this.ballVX = 0;
        this.ballVY = 0;
        this.currentBallSpeed = 0;
    }
};


window.RehabGames['pingpong'].inputRequirements = { directions: 2, inputMode: "2way" };
if (typeof window.RehabGames.register === "function") {
    window.RehabGames.register("pingpong", window.RehabGames['pingpong'], { directions: 2, inputMode: "2way" });
}
