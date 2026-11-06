window.RehabGames = window.RehabGames || {};

window.RehabGames['cardodge'] = class CarDodgeGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        
        // Фізика та стан
        this.calibMin = -20;
        this.calibMax = 20;
        this.difficulty = 'auto'; 
        
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;
        
        this.roadMargin = Math.max(20, this.width * 0.05);
        this.laneCount = 5;
        this.roadLeft = this.roadMargin;
        this.roadRight = this.width - this.roadMargin;
        this.laneWidth = (this.roadRight - this.roadLeft) / this.laneCount;
        
        this.player = {
            x: this.laneCenterX(2),
            y: 0,
            w: 0,
            h: 0,
            hitCooldown: 0
        };
        
        // Ігрові змінні
        this.enemies = [];
        this.score = 0;
        this.scoreAccum = 0;
        this.comboMultiplier = 1;
        this.timeWithoutHit = 0;
        
        // Швидкість (пікселі в секунду)
        this.baseSpeedPx = 0;
        this.currentSpeedPx = 0;
        
        // Таймери у секундах
        this.spawnTimer = 0;
        this.spawnInterval = 1.2; 
        this.roadOffset = 0;
        this.flashTimer = 0;
        
        // Smart Spawner (щоб не було непрохідних стін)
        this.recentLanes = [];
    }

    laneCenterX(lane) {
        return this.roadLeft + this.laneWidth * lane + this.laneWidth / 2;
    }

    init(canvas, options) {
        options = options || {};
        this.ctx = canvas.getContext("2d");
        this.calibMin = options.calibMin ?? -20;
        this.calibMax = options.calibMax ?? 20;
        this.difficulty = options.difficulty || 'auto';

        this.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
        this.resetGame();
        this.updateHUD();
    }
    
    resetGame() {
        this.player.x = this.laneCenterX(2);
        this.player.hitCooldown = 0;
        this.enemies = [];
        this.score = 0;
        this.scoreAccum = 0;
        this.comboMultiplier = 1;
        this.timeWithoutHit = 0;
        
        this.spawnTimer = 0;
        this.spawnInterval = 1.2;
        this.roadOffset = 0;
        this.flashTimer = 0;
        this.recentLanes = [];
    }
    
    resize(width, height) {
        this.width = width;
        this.height = height;
        
        this.roadMargin = Math.max(20, this.width * 0.05);
        this.roadLeft = this.roadMargin;
        this.roadRight = this.width - this.roadMargin;
        this.laneWidth = (this.roadRight - this.roadLeft) / this.laneCount;
        
        // Габарити машини тепер строго залежать від ширини полоси
        this.player.w = this.laneWidth * 0.65;
        this.player.h = this.player.w * 1.8;
        this.player.y = this.height - this.player.h - Math.max(20, this.height * 0.05);
        
        // Перерахунок базової швидкості під екран (проїхати екран за ~2.5 секунди)
        this.baseSpeedPx = this.height * 0.4; 
    }
    
    mapAngleToScreen(angle) {
        let clamped = Math.max(this.calibMin, Math.min(this.calibMax, angle));
        let normalized = (clamped - this.calibMin) / (this.calibMax - this.calibMin);
        if (isNaN(normalized)) normalized = 0.5;
        
        let minX = this.roadLeft + this.player.w / 2;
        let maxX = this.roadRight - this.player.w / 2;
        return minX + normalized * (maxX - minX);
    }
    
    syncCalibration() {
        this.api.updateCalibration(this.calibMin, this.calibMax);
    }
    
    updateHUD(customMsg = null) {
        let comboStr = this.comboMultiplier > 1 ? ` (Коеф x${this.comboMultiplier})` : '';
        this.api.updateHUD("hudScore", `Рахунок: ${Math.floor(this.score)}${comboStr}`);
        
        if (customMsg) {
            this.api.updateHUD("hudBotState", customMsg);
        } else {
            let diffText = this.difficulty === 'auto' ? 'Адаптивна' : 
                           this.difficulty === 'easy' ? 'Повільний' : 
                           this.difficulty === 'medium' ? 'Стандарт' : 'Швидкий';
            this.api.updateHUD("hudBotState", `Режим: ${diffText}`);
        }
    }
    
    spawnEnemy() {
        // Умний алгоритм спавну: завжди залишаємо безпечний коридор
        let allLanes = [0, 1, 2, 3, 4];
        let availableLanes = allLanes.filter(l => !this.recentLanes.includes(l));
        
        // Якщо вільних полос мало, очищаємо історію
        if (availableLanes.length <= 1) {
            this.recentLanes.shift(); 
            availableLanes = allLanes.filter(l => !this.recentLanes.includes(l));
        }
        
        const lane = availableLanes[Math.floor(Math.random() * availableLanes.length)];
        this.recentLanes.push(lane);
        
        // Зберігаємо в пам'яті лише останні 3 зайняті полоси
        if (this.recentLanes.length > 3) this.recentLanes.shift(); 

        const colors = ['#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12'];
        this.enemies.push({
            x: this.laneCenterX(lane),
            y: -this.player.h,
            w: this.player.w,
            h: this.player.h,
            color: colors[Math.floor(Math.random() * colors.length)]
        });
    }
    
    rectsOverlap(a, b) {
        // Використовуємо трохи менший хітбокс для прощення (forgiveness)
        const hitPadding = a.w * 0.15; 
        return Math.abs(a.x - b.x) < (a.w + b.w) / 2 - hitPadding &&
               Math.abs(a.y - b.y) < (a.h + b.h) / 2 - hitPadding;
    }
    
    penalize() {
        if (this.player.hitCooldown > 0) return;
        
        // Зкидаємо комбо та віднімаємо очки
        this.comboMultiplier = 1;
        this.timeWithoutHit = 0;
        this.score = Math.max(0, this.score - 5);
        
        this.player.hitCooldown = 1.5; // 1.5 секунди невразливості
        this.flashTimer = 0.3; 
        
        // Послаблюємо навантаження на пацієнта після аварії (звужуємо межі калібрування)
        let range = this.calibMax - this.calibMin;
        this.calibMax -= range * 0.05;
        this.calibMin += range * 0.05;
        this.syncCalibration();
        
        this.updateHUD("💥 Аварія! Комбо скинуто");
    }
    
    update(currentAngle, dt) {
        if (dt > 0.1) dt = 0.016; // Захист від лагів

        let boundsChanged = false;
        if (currentAngle > this.calibMax) { this.calibMax += (currentAngle - this.calibMax) * 0.05; boundsChanged = true; }
        if (currentAngle < this.calibMin) { this.calibMin -= (this.calibMin - currentAngle) * 0.05; boundsChanged = true; }
        if (boundsChanged) {
            this.syncCalibration();
        }
        
        // Плавне переміщення гравця (Lerp)
        let targetX = this.mapAngleToScreen(currentAngle);
        if (!isNaN(targetX)) {
            this.player.x += (targetX - this.player.x) * 12 * dt;
        }
        
        const minX = this.roadLeft + this.player.w / 2;
        const maxX = this.roadRight - this.player.w / 2;
        this.player.x = Math.max(minX, Math.min(maxX, this.player.x));
        
        if (this.player.hitCooldown > 0) {
            this.player.hitCooldown -= dt;
        } else {
            // Нараховуємо комбо за безпечну їзду
            this.timeWithoutHit += dt;
            if (this.timeWithoutHit > 5) {
                this.comboMultiplier = Math.min(5, 1 + Math.floor(this.timeWithoutHit / 5));
                this.updateHUD(); // Оновлюємо напис
            }
        }
        
        // Модифікатори складності
        let diffMod = 1.0;
        if (this.difficulty === 'easy') diffMod = 0.6;
        else if (this.difficulty === 'medium') diffMod = 0.9;
        else if (this.difficulty === 'hard') diffMod = 1.4;
        
        // Обчислення швидкості в пікселях на секунду
        let speedProgress = 1 + Math.min(this.score, 300) / 300; // Швидкість росте до +100%
        this.currentSpeedPx = this.baseSpeedPx * diffMod * speedProgress;
        
        let frameSpeed = this.currentSpeedPx * dt;
        
        this.roadOffset += frameSpeed;
        if (this.roadOffset > 40) this.roadOffset -= 40;
        
        // Таймер спавну у секундах
        this.spawnTimer += dt;
        let currentSpawnInterval = this.spawnInterval / (diffMod * speedProgress);
        
        if (this.spawnTimer >= currentSpawnInterval) {
            this.spawnTimer = 0;
            this.spawnEnemy();
        }
        
        // Рух та видалення ворогів
        for (let en of this.enemies) en.y += frameSpeed;
        this.enemies = this.enemies.filter(en => en.y < this.height + 100);
        
        // Перевірка колізій
        for (let en of this.enemies) {
            if (this.rectsOverlap(this.player, en)) {
                this.penalize();
            }
        }
        
        // Нарахування очок (з урахуванням комбо)
        this.scoreAccum += dt;
        if (this.scoreAccum >= 1.0) { 
            this.scoreAccum -= 1.0;
            this.score += 1 * this.comboMultiplier;
            if (this.player.hitCooldown <= 0) this.updateHUD();
        }
        
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
        }
    }
    
    drawCar(x, y, w, h, bodyColor) {
        const ctx = this.ctx;
        ctx.save();
        ctx.translate(x, y);
        
        // Тінь
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(-w/2 + 4, -h/2 + 6, w, h, 8); ctx.fill();
        } else {
            ctx.fillRect(-w/2 + 4, -h/2 + 6, w, h);
        }
        
        // Корпус машини
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-w/2, -h/2, w, h, 8);
        } else {
            ctx.rect(-w/2, -h/2, w, h);
        }
        ctx.fill();
        
        // Вікна
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(-w/2 + 6, -h/2 + 12, w - 12, h * 0.2); // Лобове
        ctx.fillRect(-w/2 + 6, h/2 - 20, w - 12, h * 0.15); // Заднє
        
        // Фари
        ctx.fillStyle = '#fff59d';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#fff59d';
        ctx.fillRect(-w/2 + 4, -h/2 + 2, 8, 6);
        ctx.fillRect(w/2 - 12, -h/2 + 2, 8, 6);
        ctx.shadowBlur = 0;
        
        ctx.restore();
    }
    
    draw(ctx) {
        
        // Фон
        ctx.fillStyle = '#2d3748';
        ctx.fillRect(0, 0, this.width, this.height);
        
        // Обочини
        let grassGrad = ctx.createLinearGradient(0, 0, this.roadMargin, 0);
        grassGrad.addColorStop(0, '#2e7d32');
        grassGrad.addColorStop(1, '#1b5e20');
        ctx.fillStyle = grassGrad;
        ctx.fillRect(0, 0, this.roadMargin, this.height);
        
        let grassGradRight = ctx.createLinearGradient(this.width - this.roadMargin, 0, this.width, 0);
        grassGradRight.addColorStop(0, '#1b5e20');
        grassGradRight.addColorStop(1, '#2e7d32');
        ctx.fillStyle = grassGradRight;
        ctx.fillRect(this.width - this.roadMargin, 0, this.roadMargin, this.height);
        
        // Смуги на обочинах (для ілюзії швидкості)
        ctx.fillStyle = '#388e3c';
        for (let y = -40 + this.roadOffset; y < this.height; y += 40) {
            ctx.fillRect(0, y, this.roadMargin, 20);
            ctx.fillRect(this.width - this.roadMargin, y, this.roadMargin, 20);
        }
        
        // Розмітка дороги
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 4;
        ctx.setLineDash([25, 25]);
        for (let i = 1; i < this.laneCount; i++) {
            const x = this.roadLeft + this.laneWidth * i;
            ctx.beginPath();
            ctx.moveTo(x, this.roadOffset - 40);
            ctx.lineTo(x, this.height);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        
        // Вороги
        for (let en of this.enemies) this.drawCar(en.x, en.y, en.w, en.h, en.color);
        
        // Гравець
        const flicker = this.player.hitCooldown > 0 && Math.floor(this.player.hitCooldown * 8) % 2 === 0;
        // Колір залежить від комбо
        let playerColor = this.comboMultiplier >= 3 ? '#00e676' : '#00f2fe';
        if (flicker) playerColor = '#ff5252';
        
        this.drawCar(this.player.x, this.player.y, this.player.w, this.player.h, playerColor);
        
        // Екран спалаху при аварії
        if (this.flashTimer > 0) {
            let alpha = Math.max(0, (this.flashTimer / 0.3) * 0.35);
            ctx.fillStyle = `rgba(255, 23, 68, ${alpha})`;
            ctx.fillRect(0, 0, this.width, this.height);
        }
    }
    
    stop() {
        this.enemies = [];
    }
};