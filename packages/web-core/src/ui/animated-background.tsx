'use client';

import { useEffect, useRef } from 'react';

export function AnimatedBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const setCanvasSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    setCanvasSize();
    window.addEventListener('resize', setCanvasSize);

    let isDark = document.documentElement.classList.contains('dark');

    const themeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName === 'class') {
          isDark = document.documentElement.classList.contains('dark');
        }
      }
    });

    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    class Particle {
      x: number;
      y: number;
      size: number;
      speedX: number;
      speedY: number;
      opacity: number;

      constructor() {
        this.x = Math.random() * (canvas?.width ?? 800);
        this.y = Math.random() * (canvas?.height ?? 600);
        this.size = Math.random() * 1.5 + 0.5;
        this.speedX = (Math.random() - 0.5) * 0.2;
        this.speedY = (Math.random() - 0.5) * 0.2;
        this.opacity = Math.random() * 0.2 + 0.05;
      }

      update() {
        this.x += this.speedX;
        this.y += this.speedY;

        if (this.x > (canvas?.width ?? 800)) this.x = 0;
        if (this.x < 0) this.x = canvas?.width ?? 800;
        if (this.y > (canvas?.height ?? 600)) this.y = 0;
        if (this.y < 0) this.y = canvas?.height ?? 600;
      }

      draw() {
        if (!ctx) return;
        const rgb = isDark ? '255, 255, 255' : '0, 0, 0';
        ctx.fillStyle = `rgba(${rgb}, ${this.opacity})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const particles: Particle[] = [];
    const particleCount = 30;
    for (let index = 0; index < particleCount; index += 1) {
      particles.push(new Particle());
    }

    let animationId: number;
    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach((particle) => {
        particle.update();
        particle.draw();
      });

      animationId = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', setCanvasSize);
      themeObserver.disconnect();
      cancelAnimationFrame(animationId);
    };
  }, []);

  return (
    <div className="absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]"
        style={{
          backgroundImage: `
            linear-gradient(to right, currentColor 1px, transparent 1px),
            linear-gradient(to bottom, currentColor 1px, transparent 1px)
          `,
          backgroundSize: '60px 60px',
        }}
      />

      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />

      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-24 left-1/4 h-[500px] w-[500px] rounded-full bg-foreground/[0.03] blur-[100px] filter animate-blob" />
        <div className="absolute -top-24 right-1/4 h-[400px] w-[400px] rounded-full bg-foreground/[0.02] blur-[80px] filter animate-blob animation-delay-2000" />
        <div className="absolute -bottom-24 left-1/3 h-[450px] w-[450px] rounded-full bg-foreground/[0.025] blur-[90px] filter animate-blob animation-delay-4000" />
      </div>

      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/30 to-background pointer-events-none" />
    </div>
  );
}
