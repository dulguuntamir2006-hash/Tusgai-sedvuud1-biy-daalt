let session = 0;          // хуучин давталтыг зогсоох токен
let gpuDevice = null;

function freshCanvas(id) {
    const old = document.getElementById(id);
    const c = old.cloneNode(false);   // шинэ canvas = шинэ context
    old.replaceWith(c);
    return c;
}

function makeOffsets(n) {
    const a = new Float32Array(n * 2);
    for (let i = 0; i < a.length; i++) a[i] = Math.random() * 1.8 - 0.9;
    return a;
}

function makeStats(el) {
    let last = performance.now(), frames = 0, cpu = 0;
    return (now, cpuMs) => {
        frames++; cpu += cpuMs;
        if (now - last >= 500) {
            const fps = Math.round(frames * 1000 / (now - last));
            const frameMs = ((now - last) / frames).toFixed(2);
            el.innerText = `FPS: ${fps} | кадр: ${frameMs} ms | CPU: ${(cpu / frames).toFixed(2)} ms`;
            frames = 0; cpu = 0; last = now;
        }
    };
}

function restartTest() {
    session++;
    if (gpuDevice) { gpuDevice.destroy(); gpuDevice = null; }
    const count = parseInt(document.getElementById("countSelect").value);
    const mode = document.getElementById("modeSelect").value;
    const offsets = makeOffsets(count);      // хоёуланд ижил өгөгдөл
    runWebGL(session, count, mode, offsets);
    runWebGPU(session, count, mode, offsets);
}

// ================= 1. WEBGL 2.0 =================
function runWebGL(id, count, mode, offsets) {
    const canvas = freshCanvas("webglCanvas");
    const statsEl = document.getElementById("webglStats");
    const gl = canvas.getContext("webgl2");
    if (!gl) { statsEl.innerText = "WebGL 2 дэмжихгүй байна"; return; }

    const vs = `#version 300 es
        in vec2 a_pos;
        in vec2 a_offset;
        uniform float u_time;
        void main() {
            float fi = a_offset.x * 10.0;
            vec2 anim = a_offset + vec2(sin(u_time + fi) * 0.04, cos(u_time + fi * 1.3) * 0.04);
            gl_Position = vec4(a_pos + anim, 0.0, 1.0);
        }`;
    const fs = `#version 300 es
        precision mediump float;
        out vec4 outColor;
        void main() { outColor = vec4(1.0, 0.3, 0.2, 1.0); }`;

    function createShader(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(s));
        return s;
    }

    try {
        const program = gl.createProgram();
        gl.attachShader(program, createShader(gl.VERTEX_SHADER, vs));
        gl.attachShader(program, createShader(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(program));

        const posLoc = gl.getAttribLocation(program, "a_pos");
        const offsetLoc = gl.getAttribLocation(program, "a_offset");
        const timeLoc = gl.getUniformLocation(program, "u_time");

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const triBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([0.0, 0.04, -0.03, -0.03, 0.03, -0.03]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        if (mode === "instanced") {
            const offBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, offBuf);
            gl.bufferData(gl.ARRAY_BUFFER, offsets, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(offsetLoc);
            gl.vertexAttribPointer(offsetLoc, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(offsetLoc, 1);
        }
        // "individual" горимд offset-ийг draw бүрт vertexAttrib2f-ээр өгнө

        gl.useProgram(program);
        const tick = makeStats(statsEl);

        function render(now) {
            if (id !== session) return;      // хуучин давталт зогсоно
            const t0 = performance.now();

            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform1f(timeLoc, now * 0.001);

            if (mode === "instanced") {
                gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, count);
            } else {
                for (let i = 0; i < count; i++) {
                    gl.vertexAttrib2f(offsetLoc, offsets[2 * i], offsets[2 * i + 1]);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                }
            }

            tick(now, performance.now() - t0);
            requestAnimationFrame(render);
        }
        requestAnimationFrame(render);
    } catch (e) {
        console.error(e);
        statsEl.innerText = "WebGL алдаа: " + e.message;
    }
}

// ================= 2. WEBGPU =================
async function runWebGPU(id, count, mode, offsets) {
    const canvas = freshCanvas("webgpuCanvas");
    const statsEl = document.getElementById("webgpuStats");
    if (!navigator.gpu) { statsEl.innerText = "WebGPU дэмжихгүй байна"; return; }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("GPU adapter олдсонгүй");
        const device = await adapter.requestDevice();
        if (id !== session) { device.destroy(); return; }
        gpuDevice = device;

        const context = canvas.getContext("webgpu");
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format });

        const module = device.createShaderModule({ code: `
            struct U { time: f32, p0: f32, p1: f32, p2: f32 };
            @group(0) @binding(0) var<uniform> uni: U;

            @vertex
            fn vs_main(@builtin(vertex_index) v: u32,
                       @location(0) offset: vec2<f32>) -> @builtin(position) vec4<f32> {
                var tri = array<vec2<f32>, 3>(
                    vec2<f32>(0.0, 0.04), vec2<f32>(-0.03, -0.03), vec2<f32>(0.03, -0.03));
                let fi = offset.x * 10.0;
                let anim = offset + vec2<f32>(sin(uni.time + fi) * 0.04,
                                              cos(uni.time + fi * 1.3) * 0.04);
                return vec4<f32>(tri[v] + anim, 0.0, 1.0);
            }

            @fragment
            fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.2, 0.8, 0.4, 1.0); }
        `});

        const pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: {
                module, entryPoint: "vs_main",
                buffers: [{
                    arrayStride: 8, stepMode: "instance",
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }]
                }]
            },
            fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
            primitive: { topology: "triangle-list" }
        });

        const offsetBuffer = device.createBuffer({
            size: offsets.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(offsetBuffer, 0, offsets);

        const uniformBuffer = device.createBuffer({
            size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
        });

        const timeData = new Float32Array(4);
        const tick = makeStats(statsEl);

        function render(now) {
            if (id !== session) return;
            const t0 = performance.now();

            timeData[0] = now * 0.001;
            device.queue.writeBuffer(uniformBuffer, 0, timeData);

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: context.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear", storeOp: "store"
                }]
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setVertexBuffer(0, offsetBuffer);

            if (mode === "instanced") {
                pass.draw(3, count, 0, 0);
            } else {
                for (let i = 0; i < count; i++) pass.draw(3, 1, 0, i);  // firstInstance = i
            }
            pass.end();
            device.queue.submit([encoder.finish()]);

            tick(now, performance.now() - t0);
            requestAnimationFrame(render);
        }
        requestAnimationFrame(render);
    } catch (err) {
        console.error(err);
        statsEl.innerText = "WebGPU алдаа: " + err.message;
    }
}

restartTest();