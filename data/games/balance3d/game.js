// ============================================================================
// ⚖️ 3D Balance Robot — Beautiful 2.5D Sliding Physics
// RehabDevice IoT | MPU6050
// ============================================================================

window.RehabGames = window.RehabGames || {};

window.RehabGames['balance3d'] = class Balance3DGame {
    constructor(ctx, api) {
        this.ctx = ctx; 
        this.api = api;
        this.width = ctx.canvas.width; 
        this.height = ctx.canvas.height;
        this.calibMin = -30; 
        this.calibMax = 30;
        
        this.init(this.calibMin, this.calibMax);
    }

    init(calibMin, calibMax) {
        this.calibMin = calibMin; 
        this.calibMax = calibMax;
        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        
        this.score = 0; 
        this.timeAlive = 0; 
        this.isGameOver = false;
        
        // Physics (Sliding on inclined plane)
        this.robotX = 0;           // Position along the board
        this.robotVX = 0;          // Velocity along the board
        this.boardAngle = 0;       // Tilt of the board in degrees
        this.windForce = 0;        
        this.difficulty = 1.0;
        
        // Visuals
        this.cameraShake = 0; 
        this.time = 0;
        this.particles = [];
        this.fallY = 0;
        this.fallVY = 0;

        this.api.updateHUD("hudScore", "⏱️ 0.0с");
        this.api.updateHUD("hudBotState", "🟢 Балансуй!");
    }

    resize(w, h) {
        this.width = w; 
        this.height = h;
    }

    update(dt, currentAngle) {
        if (dt > 0.1) dt = 0.016;
        this.time += dt;

        // Auto-calibration
        let bc = false;
        if (currentAngle > this.calibMax) { this.calibMax += (currentAngle - this.calibMax) * 0.05; bc = true; }
        if (currentAngle < this.calibMin) { this.calibMin -= (this.calibMin - currentAngle) * 0.05; bc = true; }
        if (bc) this.api.updateCalibration(this.calibMin, this.calibMax);

        // Map sensor to board angle (-30 to +30 degrees max)
        let range = this.calibMax - this.calibMin;
        let norm = range > 0 ? (currentAngle - this.calibMin) / range : 0.5;
        norm = Math.max(0, Math.min(1, norm));
        let targetBoardAngle = (norm - 0.5) * 60; 
        
        // Smoothly rotate board
        this.boardAngle += (targetBoardAngle - this.boardAngle) * 12 * dt;

        if (this.isGameOver) {
            this.gameOverTimer -= dt;
            this.cameraShake *= Math.pow(0.01, dt);
            
            // Robot falls down (gravity in screen space)
            this.fallVY += 1500 * dt;
            this.fallY += this.fallVY * dt;
            this.robotX += this.robotVX * dt;

            if (this.gameOverTimer <= 0) this.init(this.calibMin, this.calibMax);
            return;
        }

        this.timeAlive += dt;
        this.score = this.timeAlive;
        this.difficulty = 1.0 + this.timeAlive * 0.03;

        // Random wind/instability pushes the robot
        if (Math.random() < dt * 0.5) {
            this.windForce = (Math.random() - 0.5) * 300 * this.difficulty;
        } else {
            this.windForce *= Math.pow(0.5, dt); // wind dies down
        }

        // PHYSICS: Sliding on an inclined plane
        // Gravity pulls along the plane based on sin(angle)
        let gravity = 900; // pixels per second squared
        let angleRad = this.boardAngle * Math.PI / 180;
        
        // Acceleration along the board
        let accelX = Math.sin(angleRad) * gravity + this.windForce;
        
        this.robotVX += accelX * dt;
        this.robotVX *= Math.pow(0.8, dt); // Friction against the board
        this.robotX += this.robotVX * dt;

        // Board limits
        let boardWidth = 360; 
        let maxSlide = boardWidth / 2 + 10;

        // Check fall condition (slid off the edge)
        if (Math.abs(this.robotX) > maxSlide) {
            this.isGameOver = true;
            this.gameOverTimer = 3.0;
            this.cameraShake = 25;
            this.fallY = 0;
            this.fallVY = 0;
            this.api.updateHUD("hudBotState", "💥 РОБОТ ВПАВ!");
            this._createExplosion(this.robotX, 0);
        } else {
            this.api.updateHUD("hudScore", `⏱️ ${this.score.toFixed(1)}с`);
            let state = Math.abs(this.robotX) < 50 ? "🟢 По центру" : (Math.abs(this.robotX) < 130 ? "🟡 Обережно" : "🔴 КРАЙ ДОШКИ!");
            this.api.updateHUD("hudBotState", state);
        }

        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 600 * dt; // gravity
            p.life -= dt;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    }

    _createExplosion(x, y) {
        for(let i=0; i<30; i++) {
            this.particles.push({
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * 500 + this.robotVX * 0.5,
                vy: (Math.random() - 0.5) * 500 - 200,
                life: 0.5 + Math.random(),
                color: Math.random() > 0.5 ? '#00f2fe' : '#ffffff'
            });
        }
    }

    draw() {
        const ctx = this.ctx;
        const W = this.width;
        const H = this.height;

        let shakeX = (Math.random() - 0.5) * this.cameraShake;
        let shakeY = (Math.random() - 0.5) * this.cameraShake;

        // 1. Beautiful Background (Deep Space / Cyber Gradient)
        let bgGrad = ctx.createLinearGradient(0, 0, 0, H);
        bgGrad.addColorStop(0, '#040b16');
        bgGrad.addColorStop(0.6, '#0f172a');
        bgGrad.addColorStop(1, '#1e1b4b');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.translate(shakeX, shakeY);

        // Grid background for sense of space
        this._drawBeautifulGrid(ctx, W, H);

        // Center of the seesaw pivot
        let cx = W / 2;
        let cy = H * 0.65;

        // Draw Pillar (Base)
        this._drawBase(ctx, cx, cy);

        // --- BOARD & ROBOT TRANSFORMATION ---
        ctx.save();
        ctx.translate(cx, cy);
        
        if (this.isGameOver) {
            // If game over, the board tilts completely to drop the robot
            let dropAngle = this.robotX > 0 ? 45 : -45;
            ctx.rotate(dropAngle * Math.PI / 180);
        } else {
            ctx.rotate(this.boardAngle * Math.PI / 180);
        }

        // Draw The Board (Sleek 2.5D rendering)
        this._drawBoard(ctx);

        // Draw The Robot
        this._drawRobot(ctx);

        // Draw Particles
        this._drawParticles(ctx);

        ctx.restore(); // End Board Transform
        ctx.restore(); // End Shake Transform

        // Game Over Overlay
        if (this.isGameOver) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#ff1744';
            ctx.textAlign = 'center';
            ctx.font = `bold ${Math.min(W*0.08, 60)}px sans-serif`;
            ctx.fillText('СИСТЕМА ВПАЛА', W/2, H/2 - 20);
            ctx.fillStyle = '#fff';
            ctx.font = `${Math.min(W*0.04, 30)}px sans-serif`;
            ctx.fillText(`Утримався: ${this.score.toFixed(1)}с`, W/2, H/2 + 30);
        }
    }

    _drawBeautifulGrid(ctx, W, H) {
        ctx.strokeStyle = 'rgba(0, 242, 254, 0.15)';
        ctx.lineWidth = 1;
        let horizon = H * 0.4;

        // Glowing sun/planet in background
        let sunGrad = ctx.createRadialGradient(W/2, horizon, 0, W/2, horizon, 150);
        sunGrad.addColorStop(0, 'rgba(0, 242, 254, 0.8)');
        sunGrad.addColorStop(0.5, 'rgba(0, 242, 254, 0.2)');
        sunGrad.addColorStop(1, 'rgba(0, 242, 254, 0)');
        ctx.fillStyle = sunGrad;
        ctx.beginPath(); ctx.arc(W/2, horizon, 200, 0, Math.PI*2); ctx.fill();

        // Floor Grid
        ctx.beginPath();
        for (let i = -10; i <= 10; i++) {
            let x0 = W/2 + i * 20;
            let x1 = W/2 + i * 150;
            ctx.moveTo(x0, horizon);
            ctx.lineTo(x1, H);
        }
        ctx.stroke();

        let speed = (this.time * 200) % 100;
        for (let y = 0; y < H - horizon; y += 4) {
            let z = (y + speed) / 100;
            if (z < 0.1) continue;
            let py = horizon + (z * z * 10);
            if (py > H) break;
            ctx.beginPath();
            ctx.moveTo(0, py);
            ctx.lineTo(W, py);
            ctx.globalAlpha = Math.min(1, z * 0.3);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    _drawBase(ctx, cx, cy) {
        let bw = 60;
        
        // Shadow/glow
        ctx.shadowColor = '#00f2fe';
        ctx.shadowBlur = 20;
        
        let grad = ctx.createLinearGradient(cx - bw/2, cy, cx + bw/2, cy);
        grad.addColorStop(0, '#020617');
        grad.addColorStop(0.5, '#1e293b');
        grad.addColorStop(1, '#020617');
        
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(cx - 20, cy);
        ctx.lineTo(cx + 20, cy);
        ctx.lineTo(cx + bw, this.height);
        ctx.lineTo(cx - bw, this.height);
        ctx.fill();
        
        ctx.shadowBlur = 0;
        
        // Pivot joint
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(cx, cy, 25, 0, Math.PI*2);
        ctx.fill();
        
        ctx.strokeStyle = '#00f2fe';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        ctx.fillStyle = '#00f2fe';
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI*2);
        ctx.fill();
    }

    _drawBoard(ctx) {
        let bw = 360;
        let bh = 24;
        
        // 2.5D Thickness (Bottom part)
        ctx.fillStyle = '#020617';
        ctx.beginPath();
        ctx.roundRect(-bw/2, -bh/2 + 8, bw, bh, 8);
        ctx.fill();
        
        // Board Top Surface Gradient
        let grad = ctx.createLinearGradient(-bw/2, -bh/2, bw/2, -bh/2);
        grad.addColorStop(0, '#00f2fe');
        grad.addColorStop(0.5, '#4facfe');
        grad.addColorStop(1, '#00f2fe');
        
        ctx.fillStyle = grad;
        ctx.shadowColor = '#00f2fe';
        ctx.shadowBlur = 15;
        
        ctx.beginPath();
        ctx.roundRect(-bw/2, -bh/2, bw, bh, 8);
        ctx.fill();
        
        ctx.shadowBlur = 0;

        // Tech lines on board
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-bw/2 + 20, -bh/2 + 12);
        ctx.lineTo(bw/2 - 20, -bh/2 + 12);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Warning zones on edges
        ctx.fillStyle = '#ff1744';
        ctx.beginPath(); ctx.roundRect(-bw/2, -bh/2, 40, bh, {tl: 8, bl: 8}); ctx.fill();
        ctx.beginPath(); ctx.roundRect(bw/2 - 40, -bh/2, 40, bh, {tr: 8, br: 8}); ctx.fill();
    }

    _drawRobot(ctx) {
        ctx.save();
        
        let rx = this.robotX;
        let ry = -12 + (this.isGameOver ? this.fallY : 0); // board surface is at Y=-12
        
        // Robot shifts left/right
        ctx.translate(rx, ry);
        
        if (this.isGameOver) {
            ctx.rotate(this.time * 10); // spin out of control when falling
        }

        let rSize = 35; // Radius of the bot
        
        // Draw shadow on board (if not falling)
        if (!this.isGameOver) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.beginPath();
            ctx.ellipse(0, 0, rSize * 0.8, 8, 0, 0, Math.PI*2);
            ctx.fill();
        }

        // Draw sliding spark trail
        if (!this.isGameOver && Math.abs(this.robotVX) > 50) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 4;
            ctx.beginPath();
            let trailDir = -Math.sign(this.robotVX);
            ctx.moveTo(trailDir * 15, -5);
            ctx.lineTo(trailDir * (20 + Math.abs(this.robotVX) * 0.1), -5 - Math.random() * 5);
            ctx.stroke();
        }

        // Move up to draw the center of the bot
        ctx.translate(0, -rSize + 5);

        // Core glow (Radial Gradient to make it look like a 3D glass sphere)
        let rGrad = ctx.createRadialGradient(-10, -10, 5, 0, 0, rSize);
        rGrad.addColorStop(0, '#ffffff');
        rGrad.addColorStop(0.3, '#00f2fe');
        rGrad.addColorStop(0.9, '#0066cc');
        rGrad.addColorStop(1, '#000033');

        ctx.shadowColor = '#00f2fe';
        ctx.shadowBlur = 25;
        
        ctx.fillStyle = rGrad;
        ctx.beginPath();
        ctx.arc(0, 0, rSize, 0, Math.PI*2);
        ctx.fill();

        ctx.shadowBlur = 0;

        // Inner Tech Details (Eye/Visor)
        ctx.fillStyle = '#020617';
        ctx.beginPath();
        ctx.roundRect(-20, -10, 40, 16, 8);
        ctx.fill();
        
        // Glowing Eye (looks around based on velocity)
        let eyeX = (this.robotVX / 300) * 10;
        eyeX = Math.max(-12, Math.min(12, eyeX)); // clamp

        ctx.fillStyle = this.isGameOver ? '#ff1744' : '#ffffff';
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(eyeX, -2, 4, 0, Math.PI*2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Side rings (Gyroscope look)
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, rSize + 4, rSize - 10, this.robotX * 0.05, 0, Math.PI*2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.restore();
    }

    _drawParticles(ctx) {
        for (let p of this.particles) {
            ctx.globalAlpha = Math.min(1, p.life);
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI*2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
    }

    stop() {
        this.particles = [];
    }
};
