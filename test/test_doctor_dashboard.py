import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class DoctorDashboardTests(unittest.TestCase):
    browser_name = "chromium"

    @classmethod
    def setUpClass(cls):
        handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT / "data"))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.playwright = sync_playwright().start()
        cls.browser = getattr(cls.playwright, cls.browser_name).launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 390, "height": 844})
        self.page.set_default_timeout(5000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.route("**/app.js*", lambda route: route.fulfill(body="", content_type="text/javascript"))
        self.page.goto(f"http://127.0.0.1:{self.server.server_port}/", wait_until="load")
        self.page.evaluate("""async () => {
            const {StateManager} = await import('/StateManager.js');
            const {UIManager} = await import('/UIManager.js');
            window.state = new StateManager();
            window.commands = [];
            window.ui = new UIManager(state, {
                sendCommand: (...args) => commands.push(args),
                fetchAllSessionsPaginated: () => {}
            });
            ui.init();
            window.controls = ['targetNormInput', 'btnDownloadClientCSV', 'btnDeletePatient',
                'summaryStartAmp'].map(id => document.getElementById(id));
            window.patient = '\u041e\u043b\u0435\u043d\u0430 \u041a\u043e\u0432\u0430\u043b\u0435\u043d\u043a\u043e';
            window.sessions = [30, 60].map((amplitude, index) => ({
                id: index + 1, patientId: patient, amplitude, timestamp: index + 1,
                dateStr: '25.09.2026 14:35:07', smoothness: 70, flexionsCount: 12
            }));
            window.populate = (data = sessions) => {
                state.update('allSessionsData', data);
                state.update('sessionsStatus', 'ready');
                ui.renderPatientPills(data);
                ui.updateDoctorDashboardView();
            };
        }""")
        self.page.locator('[data-tab="tabDoctor"]').click()
        self.page.wait_for_function("window.ui && document.querySelector('#tabDoctor.active')")

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.errors, [])

    def assert_controls_preserved(self):
        self.assertTrue(self.page.evaluate("controls.every(node => node && node.isConnected)"))
        self.assertEqual(self.page.locator("#patientSummaryContainer .metric-box").count(), 4)
        expect(self.page.locator("#summaryCurrentAmp")).to_have_text("60.0\u00b0")
        expect(self.page.locator("#summaryTotalSessions")).to_have_text("2")
        self.assertTrue(self.page.evaluate("""() => {
            const value = getComputedStyle(document.querySelector('#summaryCurrentAmp'));
            const label = getComputedStyle(document.querySelector('.patient-summary-box .metric-title'));
            return parseFloat(value.fontSize) > parseFloat(label.fontSize) && value.color !== label.color;
        }"""))

    def check_patient_handlers(self):
        self.page.locator("#targetNormInput").fill("120")
        expect(self.page.locator("#recoveryIndexVal")).to_have_text("50%")
        with self.page.expect_download() as download_info:
            self.page.locator("#btnDownloadClientCSV").click()
        csv_text = download_info.value.path().read_text(encoding="utf-8-sig")
        self.assertEqual(len(csv_text.splitlines()), 3)
        self.assertIn(self.page.evaluate("patient"), csv_text)
        self.page.once("dialog", lambda dialog: dialog.dismiss())
        self.page.locator("#btnDeletePatient").click()
        self.assertEqual(self.page.evaluate("commands.length"), 0)
        self.page.once("dialog", lambda dialog: dialog.accept())
        self.page.locator("#btnDeletePatient").click()
        self.assertEqual(self.page.evaluate("commands"), [["deletePatient", {"patientId": self.page.evaluate("patient")}]])
        self.page.evaluate("ui.selectPatientByPill(patient)")
        expect(self.page.locator("#targetNormInput")).to_have_value("120")

    def test_empty_to_populated_to_selected(self):
        self.page.evaluate("populate([]); populate(); ui.selectPatientByPill(patient)")
        self.assert_controls_preserved()
        self.check_patient_handlers()

    def test_selected_to_no_results_to_selected(self):
        self.page.evaluate("populate(); ui.selectPatientByPill(patient); ui.updateDoctorDashboardView('missing', true); ui.selectPatientByPill(patient)")
        self.assert_controls_preserved()
        self.check_patient_handlers()

    def test_empty_search_refresh_and_norm(self):
        expect(self.page.locator("#doctorLoadingState")).to_be_visible()
        expect(self.page.locator("#doctorEmptyState")).to_be_hidden()
        self.page.evaluate("populate(); ui.selectPatientByPill(patient)")
        self.page.locator("#targetNormInput").fill("135.5")
        self.page.locator("#patientSearchInput").fill("missing")
        self.page.locator("#btnExactSearch").click()
        for _ in range(3):
            self.page.evaluate("populate()")
            expect(self.page.locator("#doctorNoResultsState")).to_be_visible()
            self.assertEqual(self.page.locator("#sessionsTableBody tr").count(), 0)
            self.assertEqual(self.page.evaluate("ui.doctorChart.data.datasets[0].data.length"), 0)
            expect(self.page.locator("#chartWrapperContainer")).to_be_hidden()
        self.page.locator("#btnShowAllPatients").click()
        self.page.locator(".patient-pill").nth(1).click()
        expect(self.page.locator("#targetNormInput")).to_have_value("135.5")
        self.page.evaluate("populate([])")
        expect(self.page.locator("#doctorEmptyState")).to_be_visible()
        self.assertEqual(self.page.locator("#sessionsTableBody tr").count(), 0)
        self.assertEqual(self.page.evaluate("ui.doctorChart.data.datasets[0].data.length"), 0)
        self.page.evaluate("populate(); ui.selectPatientByPill(patient)")
        expect(self.page.locator("#targetNormInput")).to_have_value("135.5")
        for invalid in ["", "0", "9", "181", "1e309"]:
            self.page.locator("#targetNormInput").fill(invalid)
            expect(self.page.locator("#targetNormInput")).to_have_attribute("aria-invalid", "true")
            expect(self.page.locator("#targetNormError")).to_be_visible()
            expect(self.page.locator("#recoveryIndexVal")).to_have_text("\u2014")
            self.page.evaluate("populate(); ui.selectPatientByPill(patient)")
            expect(self.page.locator("#targetNormInput")).to_have_attribute("aria-invalid", "true")
        for value in ["10", "180", "120"]:
            self.page.locator("#targetNormInput").fill(value)
            expect(self.page.locator("#targetNormInput")).to_have_attribute("aria-invalid", "false")
        self.page.evaluate("populate([...sessions, {...sessions[0], patientId: 'Other', amplitude: 20}]); ui.selectPatientByPill('Other')")
        expect(self.page.locator("#targetNormInput")).to_have_value("120")
        expect(self.page.locator("#summaryCurrentAmp")).to_have_text("20.0\u00b0")
        self.page.evaluate("ui.selectPatientByPill(patient)")
        expect(self.page.locator("#recoveryIndexVal")).to_have_text("50%")

    def test_all_patients_table_selection(self):
        self.page.evaluate("populate([...sessions, {...sessions[0], id: 3, patientId: 'Other'}])")
        self.assertEqual(self.page.evaluate('ui.selectedDoctorPatient'), 'ALL')
        expect(self.page.locator('#sessionsTableBody tr')).to_have_count(3)
        self.assertEqual(set(self.page.locator('.session-patient').all_text_contents()),
                         {self.page.evaluate('patient'), 'Other'})
        self.page.locator('.session-patient').first.click()
        expect(self.page.locator('#sessionsTableBody tr')).to_have_count(1)
        self.page.locator('.patient-pill[data-patient="ALL"]').click()
        expect(self.page.locator('#sessionsTableBody tr')).to_have_count(3)

    def test_chart_historical_amplitude(self):
        for width in [390, 1280]:
            with self.subTest(width=width):
                self.page.locator('.tab-btn:not([data-tab="tabDoctor"])').first.click()
                self.page.set_viewport_size({'width': width, 'height': 844})
                self.page.evaluate("populate([{...sessions[0], smoothness: 61, amplitude: 359.8}])")
                self.page.locator('[data-tab="tabDoctor"]').click()
                self.page.wait_for_function('ui.doctorChart.width > 0 && ui.doctorChart.height > 0')
                self.page.wait_for_function("""() => {
                    const chart = ui.doctorChart;
                    const point = chart.getDatasetMeta(0).data[0];
                    const ratio = chart.currentDevicePixelRatio;
                    const pixel = chart.ctx.getImageData(Math.floor(point.x * ratio),
                        Math.floor(point.y * ratio), 1, 1).data;
                    return Math.abs(point.y - chart.scales.y.getPixelForValue(359.8)) < 0.1
                        && Math.abs(point.x - chart.scales.x.getPixelForValue(61)) < 0.1
                        && point.options.radius >= 5 && pixel[1] > 100
                        && pixel[1] > pixel[0] * 2 && pixel[3] > 100;
                }""")
                plotted = self.page.evaluate("""() => {
                    const chart = ui.doctorChart;
                    const point = chart.getDatasetMeta(0).data[0];
                    const area = chart.chartArea;
                    const ratio = chart.currentDevicePixelRatio;
                    const pixel = chart.ctx.getImageData(Math.floor(point.x * ratio),
                        Math.floor(point.y * ratio), 1, 1).data;
                    return {max: chart.scales.y.max, raw: chart.data.datasets[0].data[0],
                        visible: !point.skip && point.y - point.options.radius >= area.top
                            && point.y + point.options.radius <= area.bottom
                            && point.x >= area.left && point.x <= area.right,
                        green: pixel[1] > 100 && pixel[1] > pixel[0] * 2 && pixel[3] > 100};
                }""")
                self.assertGreater(plotted['max'], 359.8)
                self.assertEqual(plotted['raw']['x'], 61)
                self.assertEqual(plotted['raw']['y'], 359.8)
                self.assertTrue(plotted['visible'])
                self.assertTrue(plotted['green'])
                self.page.screenshot(path=str(self.artifacts() / f'{self.browser_name}-{width}-historical-chart.png'), full_page=True)
        self.page.evaluate("""populate([
            {...sessions[0], amplitude: NaN}, {...sessions[0], amplitude: Infinity},
            {...sessions[0], amplitude: -Infinity}, {...sessions[0], smoothness: NaN},
            {...sessions[0], smoothness: Infinity}, {...sessions[0], flexionsCount: Infinity},
            {...sessions[0], flexionsCount: -5}
        ]); ui.doctorChart.update('none')""")
        self.assertEqual(self.page.evaluate('ui.doctorChart.data.datasets[0].data.length'), 2)
        self.assertEqual(self.page.evaluate('ui.doctorChart.scales.y.max'), 180)
        self.assertTrue(self.page.evaluate('ui.doctorChart.data.datasets[0].data.every(point => Number.isFinite(point.r))'))

    def test_progress_baselines(self):
        cases = [([30], "neutral", "\u041f\u043e\u0447\u0430\u0442\u043a\u043e\u0432\u0430"),
                 ([30, 30], "neutral", "(0%)"),
                 ([60, 30], "negative", "(-50%)"),
                 ([30, 60, 90], "", "(+200%)"),
                 ([0, 30], "", "\u0431\u0430\u0437\u0430 0\u00b0"),
                 ([0, 0], "neutral", "\u0431\u0430\u0437\u0430 0\u00b0")]
        for amplitudes, modifier, text in cases:
            with self.subTest(amplitudes=amplitudes):
                self.page.evaluate("""values => {
                    populate(values.map((amplitude, index) => ({...sessions[0], amplitude, timestamp: index})));
                    ui.selectPatientByPill(patient);
                }""", amplitudes)
                expect(self.page.locator("#summaryProgressBadge")).to_have_class("progress-badge" + (" " + modifier if modifier else ""))
                expect(self.page.locator("#summaryProgressBadge")).to_contain_text(text)

    def test_storage_status(self):
        self.page.evaluate("state.update('isConnected', true); state.update('globalSdAvailable', true); ui.updateMemory({used: 1, total: 2})")
        expect(self.page.locator("#memoryText")).to_have_text("SD-\u043a\u0430\u0440\u0442\u0430 \u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430")
        self.page.evaluate("state.update('globalSdAvailable', false); ui.updateMemory()")
        expect(self.page.locator("#memoryText")).to_have_text("SD-\u043a\u0430\u0440\u0442\u0430 \u0432\u0456\u0434\u0441\u0443\u0442\u043d\u044f")
        self.page.evaluate("state.update('isConnected', false)")
        expect(self.page.locator("#memoryText")).to_have_text("\u0421\u0442\u0430\u043d \u043d\u0435\u0432\u0456\u0434\u043e\u043c\u0438\u0439")
        self.assertEqual(self.page.locator(".memory-widget .memory-bar").count(), 0)

    def test_safecracker_game_lifecycle_and_dpi(self):
        self.page.set_viewport_size({"width": 320, "height": 700})
        self.page.evaluate("""async () => {
            Object.defineProperty(window, 'devicePixelRatio', {configurable: true, value: 2});
            const {GameEngine} = await import('/GameEngine.js');
            window.engine = new GameEngine(state);
            document.getElementById('gameContainer').style.display = 'flex';
            engine.startGame('safecracker');
        }""")
        self.page.wait_for_function("window.engine && engine.activeGame && engine.activeGame.constructor.name === 'SafeCrackerGame'")
        result = self.page.evaluate("""() => {
            const game = engine.activeGame;
            const canvas = document.getElementById('mainGameCanvas');
            game.update(179, 0);
            const zeroDtTime = game.safeTime;
            game.update(-179, 0);
            game.draw(canvas.getContext('2d'));
            const pixel = canvas.getContext('2d').getImageData(
                Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
            game.zoneWidth = 1;
            game.targets = Array(game.comboLength).fill(game.dialPosition);
            game.holdRequired = 0.1;
            game.update(-179, 0.1);
            game.update(-179, 0.1);
            for (let frame = 0; frame < 11 && game.state === 'opening'; frame++) {
                game.update(-179, 0.1);
            }
            return {
                signatures: [game.init.length, game.update.length, game.draw.length],
                zeroDtTime,
                continuousAngle: game.continuousAngle,
                wrappedPosition: game.dialPosition,
                backingRatio: canvas.width / canvas.clientWidth,
                rendered: pixel[3] > 0,
                scoreText: document.getElementById('hudScore').textContent,
                openedSafes: game.safesOpened,
                score: game.score,
                scrollFits: document.documentElement.scrollWidth <= innerWidth
            };
        }""")
        self.assertEqual(result['signatures'], [2, 2, 1])
        self.assertEqual(result['zeroDtTime'], 0)
        self.assertEqual(result['continuousAngle'], 181)
        self.assertEqual(result['wrappedPosition'], 1)
        self.assertEqual(result['backingRatio'], 2)
        self.assertTrue(result['rendered'])
        self.assertIn("Сейфів відкрито", result['scoreText'])
        self.assertEqual(result['openedSafes'], 1)
        self.assertGreater(result['score'], 0)
        self.assertTrue(result['scrollFits'])

        stopped = self.page.evaluate("""() => {
            const previous = engine.activeGame;
            engine.stopGame();
            document.getElementById('gameContainer').style.display = 'flex';
            engine.startGame('safecracker');
            return !previous.active && previous.particles.length === 0
                && engine.activeGame !== previous && engine.activeGame.active;
        }""")
        self.assertTrue(stopped)

        for game_id, class_name in [
            ("pingpong", "PingPongGame"),
            ("balanceboard", "BalanceBoardGame"),
            ("cardodge", "CarDodgeGame"),
            ("balance3d", "Balance3DGame"),
        ]:
            self.page.evaluate("""gameId => {
                document.getElementById('gameContainer').style.display = 'flex';
                engine.startGame(gameId);
            }""", game_id)
            self.page.wait_for_function(
                "className => engine.activeGame && engine.activeGame.constructor.name === className",
                arg=class_name,
            )
            game_check = self.page.evaluate("""() => {
                const game = engine.activeGame;
                const ctx = document.getElementById('mainGameCanvas').getContext('2d');
                game.update(0, 0, engine.input);
                game.update(NaN, NaN, engine.input);
                game.update(Infinity, -1, engine.input);
                game.draw(ctx);
                return Number.isFinite(state.get('calibMin')) && Number.isFinite(state.get('calibMax'))
                    && document.documentElement.scrollWidth <= innerWidth;
            }""")
            self.assertTrue(game_check, f"{game_id} failed non-finite input or viewport check")
            self.page.evaluate("engine.stopGame()")

        # Balance3D orthogonal 4-way board physics & downhill perspective check
        self.page.evaluate("""() => {
            document.getElementById('gameContainer').style.display = 'flex';
            engine.setTargetAngles(0, 0);
            engine.startGame('balance3d');
        }""")
        self.page.wait_for_function(
            "engine.activeGame && engine.activeGame.constructor.name === 'Balance3DGame'"
        )
        balance3d_check = self.page.evaluate("""() => {
            const game = engine.activeGame;
            const levelFarY = game._project(0, -40).y;
            const centeredX = Math.abs(game._project(0, -40).x - game._project(0, 40).x) < 1e-6;
            engine.setTargetAngles(0, 15);
            game.update(0, 0.05, engine.input);
            const purePitchNoXDrift = Math.abs(game.robotX) < 1e-6 && game.robotY < 0;
            const farEdgeDropsDownhill = game._project(0, -40).y > levelFarY;
            engine.stopGame();
            return {centeredX, purePitchNoXDrift, farEdgeDropsDownhill};
        }""")
        self.assertTrue(balance3d_check["centeredX"])
        self.assertTrue(balance3d_check["purePitchNoXDrift"])
        self.assertTrue(balance3d_check["farEdgeDropsDownhill"])

        # Non-VR single-screen 3D Dragon flight check
        self.page.evaluate("""() => {
            document.getElementById('gameContainer').style.display = 'flex';
            engine.setTargetAngles(0, 0);
            engine.startGame('vrdragon');
        }""")
        self.page.wait_for_function(
            "engine.activeGame && engine.activeGame.constructor.name === 'VRDragonGame'"
        )
        vrdragon_result = self.page.evaluate("""() => {
            const game = engine.activeGame;
            const canvas = document.getElementById('mainGameCanvas');
            const ctx = canvas.getContext('2d');
            const noVrHeadTrackingWhileActive = game._orientHandler === null && game._touchHandler === null;
            engine.setTargetAngles(18, -15);
            game.update(18, 0.1, engine.input);
            game.update(NaN, NaN, engine.input);
            game.update(Infinity, -1, engine.input);
            game.draw(ctx);
            const leftPixel = ctx.getImageData(
                Math.floor(canvas.width * 0.25), Math.floor(canvas.height * 0.5), 1, 1).data;
            const centerSkyPixel = ctx.getImageData(
                Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.22), 1, 1).data;
            const rightPixel = ctx.getImageData(
                Math.floor(canvas.width * 0.75), Math.floor(canvas.height * 0.5), 1, 1).data;
            const hudScore = document.getElementById('hudScore').textContent;
            const hudState = document.getElementById('hudBotState').textContent;
            const modeValue = document.getElementById('gameInputMode').value;
            const hasOption = !!document.querySelector('#gameSelect option[value="vrdragon"]');
            const movedX = game.dragonX > 0 && Number.isFinite(game.dragonX);
            const movedY = game.dragonY < 0 && Number.isFinite(game.dragonY);
            const signatures = [game.init.length, game.update.length, game.draw.length];
            const scrollFits = document.documentElement.scrollWidth <= innerWidth;
            const overlayTareRect = document.getElementById('btnTareGameInput').getBoundingClientRect();
            const overlayExitRect = document.getElementById('btnExitGame').getBoundingClientRect();
            const overlayButtonsFit = overlayTareRect.width > 0
                && overlayTareRect.right <= innerWidth
                && overlayExitRect.right <= innerWidth;
            engine.stopGame();
            const cleanedUp = !game.active && game._orientHandler === null
                && game.particles.length === 0 && game.mountains.length === 0;
            return {
                signatures, modeValue, hasOption, movedX, movedY,
                noVrHeadTrackingWhileActive,
                singleViewportRendered: leftPixel[3] > 0 && rightPixel[3] > 0
                    && (centerSkyPixel[0] + centerSkyPixel[1] + centerSkyPixel[2]) > 30,
                overlayButtonsFit,
                hudScore, hudState, scrollFits, cleanedUp
            };
        }""")
        self.assertEqual(vrdragon_result["signatures"], [2, 2, 1])
        self.assertEqual(vrdragon_result["modeValue"], "four-direction")
        self.assertTrue(vrdragon_result["hasOption"])
        self.assertTrue(vrdragon_result["movedX"])
        self.assertTrue(vrdragon_result["movedY"])
        self.assertTrue(vrdragon_result["noVrHeadTrackingWhileActive"])
        self.assertTrue(vrdragon_result["singleViewportRendered"])
        self.assertTrue(vrdragon_result["overlayButtonsFit"])
        self.assertIn("Очки:", vrdragon_result["hudScore"])
        self.assertIn("Кристали:", vrdragon_result["hudScore"])
        self.assertIn("Дистанція:", vrdragon_result["hudState"])
        self.assertTrue(vrdragon_result["scrollFits"])
        self.assertTrue(vrdragon_result["cleanedUp"])

        axis_audit = self.page.evaluate("""() => {
            const expectedModes = {
                pingpong: {directions: 2, inputMode: '2way'},
                balanceboard: {directions: 2, inputMode: '2way'},
                cardodge: {directions: 2, inputMode: '2way'},
                safecracker: {directions: 2, inputMode: '2way'},
                balance3d: {directions: 4, inputMode: '4way'},
                vrdragon: {directions: 4, inputMode: '4way'}
            };
            const metadataOk = Object.entries(expectedModes).every(([id, exp]) => {
                const cls = window.RehabGames[id];
                const req = cls && cls.inputRequirements;
                return cls && req && req.directions === exp.directions && req.inputMode === exp.inputMode
                    && cls.prototype.init.length === 2 && cls.prototype.update.length === 2 && cls.prototype.draw.length === 1;
            });

            // 2-way pitch immunity + tare check on pingpong
            document.getElementById('gameContainer').style.display = 'flex';
            state.updateMultiple({calibMin: -20, calibMax: 20});
            engine.setTargetAngles(10, 0);
            engine.startGame('pingpong');
            const pong = engine.activeGame;
            const centerPlayerY = pong.mapAngleToScreen(0);
            engine.setTargetAngles(10, 45);
            pong.update(10, 0.016, engine.input);
            const yAfterPitchPos = pong.playerY;
            pong.playerY = centerPlayerY;
            engine.setTargetAngles(10, -45);
            pong.update(10, 0.016, engine.input);
            const yAfterPitchNeg = pong.playerY;
            const pitchImmune = Math.abs(yAfterPitchPos - yAfterPitchNeg) < 1e-6
                && Math.abs(yAfterPitchPos - centerPlayerY) < 1e-6;

            // Runtime 4D -> 2D -> 4D mode toggle & axis inversion on vrdragon
            engine.setTargetAngles(0, 0);
            engine.startGame('vrdragon');
            const dragon = engine.activeGame;
            const selector = document.getElementById('gameInputMode');
            selector.value = 'two-direction';
            selector.dispatchEvent(new Event('change', {bubbles: true}));
            engine.setTargetAngles(15, 25);
            dragon.update(15, 0, engine.input);
            const lockedVerticalIn2D = dragon.dragonTargetY === 0 && dragon.dragonTargetX > 0;
            selector.value = 'four-direction';
            selector.dispatchEvent(new Event('change', {bubbles: true}));
            dragon.update(15, 0, engine.input);
            const activeVerticalIn4D = dragon.dragonTargetY > 0 && dragon.dragonTargetX > 0;

            // Axis inversion & 90-degree swap preserve tare zero and map axes cleanly
            engine.setRawAngles(12, -8);
            engine.tareInput();
            engine.setAxisInversion(true);
            const zeroAfterInvert = engine.input.getAxis('Horizontal') === 0 && engine.input.getAxis('Vertical') === 0;
            engine.setAxisInversion(false);
            engine.setAxisOrientation({invertX: false, invertY: true, swapAxes: true});
            const zeroAfterSwapAndPitchInvert = engine.input.getAxis('Horizontal') === 0
                && engine.input.getAxis('Vertical') === 0;
            engine.setRawAngles(12, 7); // +15 deg raw pitch delta -> mapped to +15 deg horizontal when swapped
            const swappedHorizontal = engine.input.getAxis('Horizontal') === 1
                && engine.input.getAxis('Vertical') === 0;
            engine.setAxisOrientation({invertX: false, invertY: false, swapAxes: false});
            engine.stopGame();

            return {
                metadataOk, pitchImmune, lockedVerticalIn2D, activeVerticalIn4D,
                zeroAfterInvert, zeroAfterSwapAndPitchInvert, swappedHorizontal
            };
        }""")
        self.assertTrue(axis_audit["metadataOk"])
        self.assertTrue(axis_audit["pitchImmune"])
        self.assertTrue(axis_audit["lockedVerticalIn2D"])
        self.assertTrue(axis_audit["activeVerticalIn4D"])
        self.assertTrue(axis_audit["zeroAfterInvert"])
        self.assertTrue(axis_audit["zeroAfterSwapAndPitchInvert"])
        self.assertTrue(axis_audit["swappedHorizontal"])


    def assert_no_letter_stacking(self):
        """Every table cell must keep several characters per rendered line."""
        offenders = self.page.evaluate("""() => {
            const range = document.createRange();
            return [...document.querySelectorAll('#tabDoctor th, #tabDoctor td')]
                .filter(node => node.getClientRects().length)
                .map(node => {
                    range.selectNodeContents(node);
                    const tops = new Set([...range.getClientRects()]
                        .filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
                    return {text: node.textContent.trim(), lines: tops.size};
                })
                .filter(item => [...item.text].length >= 4 && item.lines > Math.ceil([...item.text].length / 3))
                .map(item => `${item.text} => ${item.lines}`);
        }""")
        self.assertEqual(offenders, [])

    def test_mobile_session_history(self):
        self.page.evaluate("populate(); ui.selectPatientByPill(patient)")
        for width in [320, 390, 430]:
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 844})
                expect(self.page.locator("#sessionsTableBody tr")).to_have_count(2)
                self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                self.assert_no_letter_stacking()
                expect(self.page.locator('#tabDoctor thead')).to_be_visible()
                self.assertEqual(self.page.locator('#tabDoctor th').count(), 8)
                self.assertTrue(self.page.evaluate("""() => {
                    const container = document.querySelector('#tabDoctor .table-container');
                    return getComputedStyle(container).overflowX === 'auto'
                        && container.scrollWidth > container.clientWidth
                        && getComputedStyle(document.querySelector('#sessionsTableBody tr')).display === 'table-row'
                        && [...document.querySelectorAll('#tabDoctor th, #tabDoctor td')]
                            .every(cell => getComputedStyle(cell).whiteSpace === 'nowrap'
                                && parseFloat(getComputedStyle(cell).fontSize) <= 12);
                }"""))
                delete_button = self.page.locator("#sessionsTableBody .btn-delete-session")
                self.assertEqual(delete_button.count(), 2)
                self.page.evaluate("""() => {
                    const container = document.querySelector('#tabDoctor .table-container');
                    container.scrollLeft = container.scrollWidth;
                }""")
                # Engines report a stale empty rect right after a resize, so wait for laid-out geometry.
                delete_box = self.page.wait_for_function("""() => {
                    const rect = document.querySelector('#sessionsTableBody .btn-delete-session')
                        .getBoundingClientRect();
                    return rect.height > 0 ? rect.toJSON() : null;
                }""").json_value()
                self.assertGreaterEqual(delete_box["height"], 44 - 0.01)
                self.assertLessEqual(delete_box["right"], width + 0.01)
                self.page.screenshot(path=str(self.artifacts() / f"{self.browser_name}-{width}-sessions.png"), full_page=True)
        self.page.once("dialog", lambda dialog: dialog.accept())
        self.page.locator("#sessionsTableBody .btn-delete-session").first.click()
        self.assertEqual(self.page.evaluate("commands.pop()"), ["deleteSession", {"id": 2}])

    def test_game_input_pipeline_modes_and_tare(self):
        self.page.set_viewport_size({"width": 320, "height": 844})
        self.page.locator('[data-tab="tabPatient"]').click()
        self.page.wait_for_function("document.querySelector('#tabPatient.active')")
        result = self.page.evaluate("""async () => {
            const {GameEngine, GameInput} = await import('/GameEngine.js');
            const input = new GameInput();
            input.setAngles(5, 10);
            input.tare();
            input.setAngles(20, 25);
            const horizontal = input.getAxis('Horizontal');
            const verticalInTwoDirectionMode = input.getAxis('Vertical');
            input.mode = 'four-direction';
            const verticalInFourDirectionMode = input.getAxis('Vertical');
            input.configure({deadzone: 0.08, sensitivityDeg: 60});
            input.tare();
            input.setAngles(22, 27);
            const insideDeadzone = input.getAxis('Horizontal');
            const nonFiniteAxis = input.normalize(NaN, 0);
            const largeNegativeWrap = input.normalize(-705, 0);

            const engine = new GameEngine(state);
            window.engineInstance = engine;
            const selector = document.getElementById('gameInputMode');
            const gameSelect = document.getElementById('gameSelect');
            const initialMode = selector.value;
            const twoWayGames = [...gameSelect.options].map(opt => opt.value);
            const initialFourWayControlsHidden = document.getElementById('fourWayOrientationControls').hidden;
            const initialBalanceVisualizerHidden = document.getElementById('balanceBoardVisualizer').hidden;
            const noDuplicateTareInPatientTab = !document.querySelector('#tabPatient #btnTareGameInput')
                && !!document.querySelector('#gameContainer #btnTareGameInput');
            const modeSelectVisibleWithoutSession = selector.getBoundingClientRect().width > 0
                && window.getComputedStyle(document.getElementById('authActivePanel')).display === 'none'
                && window.getComputedStyle(document.getElementById('authGuestPanel')).display !== 'none';

            document.getElementById('authActivePanel').style.display = 'flex';
            const modeBounds = selector.getBoundingClientRect();
            const selectBounds = gameSelect.getBoundingClientRect();
            const startBounds = document.getElementById('btnModeGame').getBoundingClientRect();
            const recalBounds = document.getElementById('btnRecalibrate').getBoundingClientRect();
            const controlsFit = modeBounds.width > 0 && modeBounds.right <= innerWidth
                && selectBounds.width > 0 && selectBounds.right <= innerWidth
                && startBounds.width > 0 && startBounds.right <= innerWidth
                && recalBounds.width > 0 && recalBounds.right <= innerWidth
                && document.documentElement.scrollWidth <= innerWidth;

            selector.value = 'four-direction';
            selector.dispatchEvent(new Event('change', {bubbles: true}));
            const selectedFourDirectionMode = engine.input.mode;
            const fourWaySensitivity = engine.input.sensitivityDeg;
            const fourWayGames = [...gameSelect.options].map(opt => opt.value);
            const fourWayControlsVisible = !document.getElementById('fourWayOrientationControls').hidden
                && !document.getElementById('balanceBoardVisualizer').hidden
                && document.getElementById('circleIndicator').hidden
                && !document.getElementById('dualAngleReadout').hidden;

            selector.value = 'two-direction';
            selector.dispatchEvent(new Event('change', {bubbles: true}));
            const restoredTwoWayGames = [...gameSelect.options].map(opt => opt.value);
            const twoWaySensitivity = engine.input.sensitivityDeg;

            window.RehabGames.register('four-axis-probe', class {}, {directions: 4});
            engine.activeGame = new window.RehabGames['four-axis-probe']();
            engine.applyInputMode();
            const requiredMode = selector.value;
            engine.setTargetAngles(12, 18);
            engine.tareInput();
            const taredRoll = engine.input.rollTare;
            const taredPitch = engine.input.pitchTare;
            engine.activeGame = null;
            engine.applyInputMode();

            commands.length = 0;
            document.getElementById('btnRecalibrate').click();
            const recalCommandSent = commands.length === 1 && commands[0][0] === 'recalibrate'
                && engine.input.rollTare === 0 && engine.input.pitchTare === 0;

            return {
                horizontal, verticalInTwoDirectionMode, verticalInFourDirectionMode,
                insideDeadzone, nonFiniteAxis, largeNegativeWrap, initialMode,
                twoWayGames, fourWayGames, restoredTwoWayGames,
                initialFourWayControlsHidden, initialBalanceVisualizerHidden, fourWayControlsVisible,
                noDuplicateTareInPatientTab, modeSelectVisibleWithoutSession,
                fourWaySensitivity, twoWaySensitivity,
                selectedFourDirectionMode, requiredMode, taredRoll, taredPitch,
                restoredMode: selector.value, recalCommandSent, controlsFit,
                controlBounds: {
                    viewport: innerWidth,
                    mode: modeBounds.toJSON(),
                    gameSelect: selectBounds.toJSON(),
                    start: startBounds.toJSON(),
                    recal: recalBounds.toJSON()
                }
            };
        }""")
        self.assertAlmostEqual(result["horizontal"], (0.5 - 0.08) / 0.92)
        self.assertEqual(result["verticalInTwoDirectionMode"], 0)
        self.assertAlmostEqual(result["verticalInFourDirectionMode"], (0.5 - 0.08) / 0.92)
        self.assertEqual(result["insideDeadzone"], 0)
        self.assertEqual(result["nonFiniteAxis"], 0)
        self.assertAlmostEqual(result["largeNegativeWrap"], (0.25 - 0.08) / 0.92)
        self.assertEqual(result["initialMode"], "two-direction")
        self.assertEqual(result["twoWayGames"], ["pingpong", "balanceboard", "cardodge", "safecracker"])
        self.assertEqual(result["fourWayGames"], ["balance3d", "vrdragon"])
        self.assertEqual(result["restoredTwoWayGames"], ["pingpong", "balanceboard", "cardodge", "safecracker"])
        self.assertTrue(result["initialFourWayControlsHidden"])
        self.assertTrue(result["initialBalanceVisualizerHidden"])
        self.assertTrue(result["fourWayControlsVisible"])
        self.assertTrue(result["noDuplicateTareInPatientTab"])
        self.assertTrue(result["modeSelectVisibleWithoutSession"])
        self.assertEqual(result["fourWaySensitivity"], 15)
        self.assertEqual(result["twoWaySensitivity"], 30)
        self.assertTrue(result["controlsFit"], result["controlBounds"])
        self.assertEqual(result["selectedFourDirectionMode"], "four-direction")
        self.assertEqual(result["requiredMode"], "four-direction")
        self.assertEqual((result["taredRoll"], result["taredPitch"]), (12, 18))
        self.assertEqual(result["restoredMode"], "two-direction")
        self.assertTrue(result["recalCommandSent"])

    def test_dual_axis_polling_and_websocket_messages(self):
        result = self.page.evaluate("""async () => {
            const {NetworkService} = await import('/NetworkService.js');
            const service = new NetworkService();
            const originalFetch = window.fetch;
            window.fetch = async () => ({json: async () => ({angle: '12.00', roll: 12, pitch: -7})});
            const polledAngle = new Promise(resolve => service.onMessage(message => {
                if (message.type === 'angle') resolve(message);
            }));
            service.pollOnce();
            const polling = await polledAngle;
            window.fetch = originalFetch;
            let websocket;
            service.onMessage(message => { websocket = message; });
            service.handleServerMessage({type: 'angle', angle: 4, roll: 4, pitch: 9});
            return {polling, websocket};
        }""")
        self.assertEqual(result["polling"], {"type": "angle", "angle": 12, "roll": 12, "pitch": -7})
        self.assertEqual(result["websocket"], {"type": "angle", "angle": 4, "roll": 4, "pitch": 9})

    @staticmethod
    def artifacts():
        path = ROOT / ".pio" / "dashboard-checks"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def test_layout_matrix(self):
        artifacts = self.artifacts()
        self.page.evaluate("""() => {
            patient = '\u041e\u043b\u0435\u043d\u0430-\u041c\u0430\u0440\u0456\u044f \u041a\u043e\u0432\u0430\u043b\u0435\u043d\u043a\u043e-\u041f\u0435\u0442\u0440\u0435\u043d\u043a\u043e ' + '\u041e\u043b\u0435\u043a\u0441\u0430\u043d\u0434\u0440\u0456\u0432\u043d\u0430'.repeat(4) + ' <img src=x>';
            sessions = sessions.map(session => ({...session, patientId: patient,
                dateStr: '25.09.2026, 14:35:07 (\u043a\u0438\u0457\u0432\u0441\u044c\u043a\u0438\u0439 \u0447\u0430\u0441)'}));
            populate(); ui.selectPatientByPill(patient);
            document.querySelector('#statusText').textContent = '\u0412\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043e (\u043e\u0447\u0456\u043a\u0443\u0432\u0430\u043d\u043d\u044f HTTP, \u043f\u0435\u0440\u0435\u043f\u0456\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043d\u044f...)';
        }""")
        self.assertEqual(self.page.locator("#summaryPatientName img").count(), 0)
        for width in [320, 390, 430, 768, 1280]:
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 844})
                self.page.wait_for_function("ui.doctorChart.width > 0 && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) > 0")
                self.page.evaluate("window.scrollTo(0, 0)")
                expect(self.page.locator("#summaryPatientName")).to_have_text(self.page.evaluate("patient"))
                self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                self.assertNotEqual(self.page.evaluate("getComputedStyle(document.body).overflowX"), "hidden")
                self.assertEqual(self.page.evaluate("""() => {
                    const root = document.querySelector('#tabDoctor');
                    return [...root.querySelectorAll('*')].filter(node => {
                        if (node.closest('.table-container, .chart-wrapper') || !node.getClientRects().length) return false;
                        const rect = node.getBoundingClientRect();
                        return rect.left < -1 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1;
                    }).map(node => node.id || node.className);
                }"""), [])
                self.assert_controls_preserved()
                self.assert_no_letter_stacking()
                for selector in ["#btnExactSearch", "#btnDownloadCSV", "#btnDownloadClientCSV", "#btnDeletePatient", ".patient-pill", "#targetNormInput"]:
                    self.assertGreaterEqual(self.page.locator(selector).first.bounding_box()["height"], 44 - 0.01)
                expected_tracks = 1 if width <= 480 else 2 if width <= 1000 else 4
                self.assertEqual(self.page.evaluate("getComputedStyle(document.querySelector('#patientSummaryContainer .metrics-grid')).gridTemplateColumns.split(' ').length"), expected_tracks)
                chart_height = self.page.locator("#chartWrapperContainer").bounding_box()["height"]
                self.page.evaluate("populate(); populate()")
                self.assertAlmostEqual(
                    self.page.locator("#chartWrapperContainer").bounding_box()["height"],
                    chart_height,
                    delta=0.01,
                )
                self.page.screenshot(path=str(artifacts / f"{self.browser_name}-{width}-full.png"), full_page=True)
                self.page.locator("#targetNormInput").fill("120")
                expect(self.page.locator("#recoveryIndexVal")).to_have_text("50%")
                self.page.wait_for_function("""() => {
                    const header = document.querySelector('header').getBoundingClientRect();
                    const input = document.querySelector('#targetNormInput').getBoundingClientRect();
                    return Math.abs(header.top) < 1 && input.top >= header.bottom && input.bottom <= innerHeight;
                }""")
                self.assertNotEqual(self.page.locator("#targetNormInput").evaluate("node => getComputedStyle(node).outlineStyle"), "none")
                self.page.screenshot(path=str(artifacts / f"{self.browser_name}-{width}-focus.png"))
                self.page.locator("#patientSearchInput").fill("missing")
                self.page.locator("#patientSearchInput").press("Enter")
                expect(self.page.locator("#doctorNoResultsState")).to_be_visible()
                self.page.locator(".patient-pill").nth(1).click()
                expect(self.page.locator("#targetNormInput")).to_have_value("120")
                with self.page.expect_download():
                    self.page.locator("#btnDownloadCSV").click()

    def test_real_network_state_flow(self):
        payload = bytes(self.page.evaluate("Array.from(msgpack.encode(sessions))"))
        full_page = bytes(self.page.evaluate("Array.from(msgpack.encode(Array.from({length: 50}, (_, index) => ({...sessions[0], id: index + 100, timestamp: 0}))))"))
        pending = []
        self.page.route("**/api/sessions?**", lambda route: pending.append(route))
        self.page.unroute("**/app.js*")
        self.page.add_init_script("""window.WebSocket = class {
            static OPEN = 1;
            readyState = 1;
            constructor() { queueMicrotask(() => this.onopen?.()); }
            send() {}
            close() {}
        };""")
        self.page.reload(wait_until="load")
        self.page.locator('[data-tab="tabDoctor"]').click()
        expect(self.page.locator("#doctorLoadingState")).to_be_visible()
        expect(self.page.locator("#doctorEmptyState")).to_be_hidden()
        self.assertEqual(len(pending), 1)
        pending.pop().fulfill(body=b"\x90", content_type="application/msgpack")
        expect(self.page.locator("#doctorEmptyState")).to_be_visible()
        self.page.locator('[data-tab="tabDoctor"]').click()
        expect(self.page.locator("#doctorLoadingState")).to_be_visible()
        pending.pop().fulfill(body=payload, content_type="application/msgpack")
        expect(self.page.locator(".patient-pill")).to_have_count(2)
        self.page.locator(".patient-pill").nth(1).click()
        self.page.locator("#targetNormInput").fill("120")
        self.page.locator('[data-tab="tabDoctor"]').click()
        expect(self.page.locator("#doctorLoadingState")).to_be_visible()
        expect(self.page.locator("#chartWrapperContainer")).to_be_hidden()
        self.assertEqual(self.page.locator("#sessionsTableBody tr").count(), 0)
        pending.pop().fulfill(status=503, body="Unavailable")
        expect(self.page.locator("#doctorErrorState")).to_be_visible()
        expect(self.page.locator("#doctorEmptyState")).to_be_hidden()
        self.page.locator("#btnRetrySessions").click()
        expect(self.page.locator("#doctorLoadingState")).to_be_visible()
        pending.pop().fulfill(body=b"invalid msgpack", content_type="application/msgpack")
        expect(self.page.locator("#doctorErrorState")).to_be_visible()
        self.page.locator("#btnRetrySessions").click()
        expect(self.page.locator("#doctorLoadingState")).to_be_visible()
        with self.page.expect_request("**/api/sessions?offset=50&limit=50"):
            pending.pop().fulfill(body=full_page, content_type="application/msgpack")
        expect(self.page.locator("#doctorLoadingState")).to_be_visible()
        pending.pop().fulfill(body=payload, content_type="application/msgpack")
        expect(self.page.locator("#patientSummaryContainer")).to_be_visible()
        expect(self.page.locator("#sessionsTableBody tr")).to_have_count(52)
        expect(self.page.locator("#targetNormInput")).to_have_value("120")
        expect(self.page.locator("#recoveryIndexVal")).to_have_text("50%")

    def test_four_way_session_protocols_orientation_tare_and_low_storage(self):
        self.page.set_viewport_size({"width": 320, "height": 844})
        self.page.locator('[data-tab="tabPatient"]').click()
        self.page.wait_for_function("document.querySelector('#tabPatient.active')")

        # Low-storage guard (<100 KiB without SD card) blocks session start to protect un-migrated data
        self.page.evaluate("""async () => {
            const {GameEngine} = await import('/GameEngine.js');
            window.engineInstance = new GameEngine(state);
            window.engineInstance.onAutoTare = (tareRoll, tarePitch) => {
                commands.push(['setTare', {tareRoll, tarePitch}]);
            };
            state.updateMultiple({
                isConnected: true,
                globalSdAvailable: false,
                storageLowSpace: true
            });
        }""")
        expect(self.page.locator("#memoryText")).to_have_text("Пам'ять заповнена (<100 КБ)")
        self.page.locator("#patientIdInput").fill("Іван Баланс")
        alerts = []
        self.page.once("dialog", lambda d: (alerts.append(d.message), d.accept()))
        self.page.locator("#btnStartSession").click()
        self.assertEqual(len(alerts), 1)
        self.assertIn("100 КБ", alerts[0])
        self.assertIn("SD-карту", alerts[0])
        self.assertEqual(self.page.evaluate("commands.length"), 0)
        self.assertFalse(self.page.evaluate("state.get('isAuthorized')"))

        # Clear low-space flag: LittleFS without SD starts cleanly with no false data-loss alert
        self.page.evaluate("state.update('storageLowSpace', false)")
        expect(self.page.locator("#memoryText")).to_have_text("SD-карта відсутня")
        expect(self.page.locator("#fourWayProtocolGroup")).to_be_hidden()

        # Select 4-way mode + Static Hold protocol, configure orientation, and start session
        self.page.locator("#gameInputMode").select_option("four-direction")
        expect(self.page.locator("#fourWayProtocolGroup")).to_be_visible()
        expect(self.page.locator("#balanceProtocolSelect")).to_have_value("dynamic")
        self.page.locator("#balanceProtocolSelect").select_option("static")

        # Verify neutral target ring CSS matches <=5 deg zone (31% of 2D visualizer)
        ring_pct = self.page.evaluate("""() => {
            const board = document.getElementById('balanceBoardVisualizer').getBoundingClientRect();
            const ring = document.querySelector('.balance-ring-inner').getBoundingClientRect();
            return (ring.width / board.width) * 100;
        }""")
        self.assertAlmostEqual(ring_pct, 31.0, delta=2.0)

        self.page.locator("#invertAngleToggle").check()
        self.page.locator("#swapAxesToggle").check()
        self.page.evaluate("commands.length = 0")
        self.page.locator("#btnStartSession").click()

        static_state = self.page.evaluate("""() => {
            state.update('liveStats', {
                type: 'liveStats',
                sessionMode: 1,
                minAngle: -3.2,
                maxAngle: 2.8,
                amplitude: 5.5,
                avgSpeed: 6.4,
                smoothness: 94,
                flexionsCount: 0,
                sessionDuration: 30.0,
                swayRms: 2.1,
                mlRms: 1.5,
                apRms: 1.5,
                stabilityPct: 86,
                meanRoll: 0.5,
                meanPitch: -0.7
            });
            return {
                cmd: commands[0],
                modeDisabled: document.getElementById('gameInputMode').disabled,
                protoDisabled: document.getElementById('balanceProtocolSelect').disabled,
                launchHidden: document.getElementById('activeGameLaunchGroup').hidden,
                hintHidden: document.getElementById('staticHoldActiveHint').hidden,
                title1: document.getElementById('statTitle1').textContent,
                title2: document.getElementById('statTitle2').textContent,
                statMin: document.getElementById('statMin').textContent,
                statAmp: document.getElementById('statAmp').textContent,
                statSmooth: document.getElementById('statSmooth').textContent,
                statFlex: document.getElementById('statFlex').textContent,
                scrollFits: document.documentElement.scrollWidth <= innerWidth
            };
        }""")
        self.assertEqual(static_state["cmd"], [
            "startSession",
            {
                "patientId": "Іван Баланс",
                "sessionMode": 1,
                "invertX": True,
                "invertY": False,
                "swapAxes": True,
                "tareRoll": 0,
                "tarePitch": 0,
            },
        ])
        self.assertTrue(static_state["modeDisabled"])
        self.assertTrue(static_state["protoDisabled"])
        self.assertTrue(static_state["launchHidden"])
        self.assertFalse(static_state["hintHidden"])
        self.assertEqual(static_state["title1"], "Відхилення Sway RMS")
        self.assertEqual(static_state["title2"], "Утримання центру (≤5°)")
        self.assertEqual(static_state["statMin"], "2.1°")
        self.assertEqual(static_state["statAmp"], "86%")
        self.assertEqual(static_state["statSmooth"], "94%")
        self.assertEqual(static_state["statFlex"], "0.5° / -0.7°")
        self.assertTrue(static_state["scrollFits"])

        # Stopping session unlocks mode & sub-protocol selectors and restores game launcher visibility
        self.page.locator("#btnStopSession").click()
        unlocked = self.page.evaluate("""() => ({
            modeDisabled: document.getElementById('gameInputMode').disabled,
            protoDisabled: document.getElementById('balanceProtocolSelect').disabled,
            launchHidden: document.getElementById('activeGameLaunchGroup').hidden,
            hintHidden: document.getElementById('staticHoldActiveHint').hidden
        })""")
        self.assertEqual(unlocked, {
            "modeDisabled": False,
            "protoDisabled": False,
            "launchHidden": False,
            "hintHidden": True,
        })

        # Start Dynamic 4-way session, verify orientation sync, auto-tare, and manual tare commands
        self.page.locator("#balanceProtocolSelect").select_option("dynamic")
        self.page.locator("#patientIdInput").fill("Іван Баланс")
        self.page.evaluate("commands.length = 0")
        self.page.locator("#btnStartSession").click()
        self.assertEqual(self.page.evaluate("commands[0][1].sessionMode"), 2)
        self.assertFalse(self.page.evaluate("document.getElementById('activeGameLaunchGroup').hidden"))

        dynamic_sync = self.page.evaluate("""() => {
            commands.length = 0;
            window.engineInstance.setTargetAngles(9, -6);
            document.getElementById('btnTareGameInput').click();
            const tareCmd = commands.pop();

            const pitchToggle = document.getElementById('invertPitchToggle');
            pitchToggle.checked = true;
            pitchToggle.dispatchEvent(new Event('change', {bubbles: true}));
            const orientCmd = commands.pop();

            state.update('liveStats', {
                type: 'liveStats',
                sessionMode: 2,
                minAngle: -14,
                maxAngle: 16,
                minPitch: -11,
                maxPitch: 13,
                amplitude: 27.0,
                avgSpeed: 24.5,
                smoothness: 89,
                sessionDuration: 45.0,
                qFL: 25,
                qFR: 25,
                qBL: 25,
                qBR: 25,
                symmetryPct: 100
            });
            return {
                tareCmd,
                orientCmd,
                statSpanML: document.getElementById('statMin').textContent,
                statSpanAP: document.getElementById('statMax').textContent,
                statAmp: document.getElementById('statAmp').textContent,
                statSym: document.getElementById('statFlex').textContent
            };
        }""")
        self.assertEqual(dynamic_sync["tareCmd"], ["setTare", {"tareRoll": 9, "tarePitch": -6}])
        self.assertEqual(dynamic_sync["orientCmd"][0], "syncOrientation")
        self.assertTrue(dynamic_sync["orientCmd"][1]["invertY"])
        self.assertEqual(dynamic_sync["orientCmd"][1]["tarePitch"], 6)
        self.assertEqual(dynamic_sync["statSpanML"], "30.0°")
        self.assertEqual(dynamic_sync["statSpanAP"], "24.0°")
        self.assertEqual(dynamic_sync["statAmp"], "27.0°")
        self.assertEqual(dynamic_sync["statSym"], "100%")

    def test_doctor_balance_protocols_quadrant_widget_and_csv(self):
        self.page.set_viewport_size({"width": 320, "height": 844})
        self.page.evaluate("""() => {
            const rawMixed = [
                // Sparse Wrist rows (no 4-way keys, matching firmware stepSessionRow)
                {
                    id: 1, patientId: patient, sessionMode: 0, timestamp: 10,
                    dateStr: '01.10.2026 10:00:00', minAngle: -15, maxAngle: 15,
                    amplitude: 30, avgSpeed: 20, smoothness: 68, flexionsCount: 10, sessionDuration: 40
                },
                {
                    id: 2, patientId: patient, sessionMode: 0, timestamp: 20,
                    dateStr: '02.10.2026 10:00:00', minAngle: -30, maxAngle: 30,
                    amplitude: 60, avgSpeed: 28, smoothness: 82, flexionsCount: 18, sessionDuration: 55
                },
                // Static Balance rows (lower swayRms = improvement!)
                {
                    id: 3, patientId: patient, sessionMode: 1, timestamp: 30,
                    dateStr: '03.10.2026 10:00:00', minAngle: -8, maxAngle: 7,
                    amplitude: 14, avgSpeed: 9, smoothness: 72, flexionsCount: 0, sessionDuration: 45,
                    minPitch: -6, maxPitch: 7, meanRoll: 2.4, meanPitch: -1.8,
                    swayRms: 4.8, mlRms: 3.4, apRms: 3.4, stabilityPct: 52,
                    qFL: 35, qFR: 20, qBL: 25, qBR: 20
                },
                {
                    id: 4, patientId: patient, sessionMode: 1, timestamp: 40,
                    dateStr: '04.10.2026 10:00:00', minAngle: -5, maxAngle: 5,
                    amplitude: 9, avgSpeed: 5, smoothness: 90, flexionsCount: 0, sessionDuration: 60,
                    minPitch: -4, maxPitch: 4, meanRoll: 0.6, meanPitch: -0.5,
                    swayRms: 2.4, mlRms: 1.7, apRms: 1.7, stabilityPct: 84,
                    qFL: 30, qFR: 22, qBL: 26, qBR: 22
                },
                // Dynamic Balance rows (higher 2D span & quadrant symmetry = improvement!)
                {
                    id: 5, patientId: patient, sessionMode: 2, timestamp: 50,
                    dateStr: '05.10.2026 10:00:00', minAngle: -8, maxAngle: 8,
                    amplitude: 14, avgSpeed: 18, smoothness: 74, flexionsCount: 0, sessionDuration: 75,
                    minPitch: -6, maxPitch: 6, meanRoll: 1.2, meanPitch: 0.8,
                    swayRms: 5.2, mlRms: 3.8, apRms: 3.5, stabilityPct: 35,
                    qFL: 45, qFR: 15, qBL: 25, qBR: 15
                },
                {
                    id: 6, patientId: patient, sessionMode: 2, timestamp: 60,
                    dateStr: '06.10.2026 10:00:00', minAngle: -15, maxAngle: 15,
                    amplitude: 28, avgSpeed: 26, smoothness: 88, flexionsCount: 0, sessionDuration: 90,
                    minPitch: -13, maxPitch: 13, meanRoll: 0.2, meanPitch: 0.1,
                    swayRms: 8.4, mlRms: 6.0, apRms: 5.9, stabilityPct: 22,
                    qFL: 25, qFR: 25, qBL: 25, qBR: 25
                },
                // Balance-only patient (zero Wrist sessions)
                {
                    id: 7, patientId: 'Тарас Баланс', sessionMode: 1, timestamp: 70,
                    dateStr: '07.10.2026 11:00:00', minAngle: -4, maxAngle: 4,
                    amplitude: 8, avgSpeed: 4.5, smoothness: 91, flexionsCount: 0, sessionDuration: 50,
                    minPitch: -4, maxPitch: 4, meanRoll: -0.3, meanPitch: 0.4,
                    swayRms: 2.2, mlRms: 1.6, apRms: 1.5, stabilityPct: 88,
                    qFL: 26, qFR: 24, qBL: 25, qBR: 25
                }
            ];
            const roundTripped = msgpack.decode(msgpack.encode(rawMixed));
            populate(roundTripped);
        }""")

        # Protocol pills show ALL counts across the 3 clinical modes
        expect(self.page.locator("#doctorProtocolSwitch")).to_be_visible()
        pills = self.page.locator("#doctorProtocolSwitch .protocol-pill")
        expect(pills).to_have_count(3)
        expect(pills.nth(0)).to_have_text("↔ Кисть (2)")
        expect(pills.nth(0)).to_have_attribute("aria-pressed", "true")
        expect(pills.nth(1)).to_have_text("🎯 Баланс: Статика (3)")
        expect(pills.nth(1)).to_have_attribute("aria-pressed", "false")
        expect(pills.nth(2)).to_have_text("🎮 Баланс: Динаміка (2)")

        # Selecting a balance-only patient auto-switches protocol from 0 -> 1
        self.page.locator('.patient-pill[data-patient="Тарас Баланс"]').click()
        expect(pills.nth(1)).to_have_attribute("aria-pressed", "true")
        expect(self.page.locator("#patientSummaryContainer")).to_be_visible()
        expect(self.page.locator("#summaryCurrentAmp")).to_have_text("2.2°")

        # Explicit click on 0-count Wrist pill shows protocol-specific empty message while keeping strip visible
        pills.nth(0).click()
        expect(self.page.locator("#doctorNoResultsState")).to_be_visible()
        expect(self.page.locator("#doctorNoResultsText")).to_contain_text("немає сесій у протоколі «Кисть»")
        expect(self.page.locator("#doctorProtocolSwitch")).to_be_visible()

        # Select multi-modal Patient A and inspect Static Balance protocol (inverted Sway RMS polarity)
        patient_name = self.page.evaluate("patient")
        self.page.locator(f'.patient-pill[data-patient="{patient_name}"]').click()
        pills.nth(1).click()
        expect(self.page.locator("#summaryStartAmp")).to_have_text("4.8°")
        expect(self.page.locator("#summaryCurrentAmp")).to_have_text("2.4°")
        expect(self.page.locator("#summaryProgressBadge")).to_have_class("progress-badge")
        expect(self.page.locator("#summaryProgressBadge")).to_contain_text("Зменшення коливань: -2.4° (-50%)")
        expect(self.page.locator("#targetNormInput")).to_have_value("80")
        expect(self.page.locator("#recoveryIndexVal")).to_have_text("105%")
        self.page.locator("#targetNormInput").fill("101")
        expect(self.page.locator("#targetNormInput")).to_have_attribute("aria-invalid", "true")
        self.page.locator("#targetNormInput").fill("80")

        # Verify 2D Quadrant & CoB SVG widget + zero horizontal overflow at 320px
        quad_check = self.page.evaluate("""() => {
            const root = document.querySelector('#tabDoctor');
            const overflows = [...root.querySelectorAll('*')].filter(node => {
                if (node.closest('.table-container, .chart-wrapper') || !node.getClientRects().length) return false;
                const rect = node.getBoundingClientRect();
                return rect.left < -1 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1;
            }).map(node => node.id || node.className);
            const dot = document.getElementById('quadLatestCobDot');
            return {
                widgetVisible: !document.getElementById('balanceQuadrantWidget').hidden,
                metricBoxCount: document.querySelectorAll('#patientSummaryContainer .metric-box').length,
                qVals: ['quadValFL', 'quadValFR', 'quadValBL', 'quadValBR'].map(id => document.getElementById(id).textContent),
                cx: parseFloat(dot.getAttribute('cx')),
                cy: parseFloat(dot.getAttribute('cy')),
                scrollFits: document.documentElement.scrollWidth <= innerWidth,
                overflows
            };
        }""")
        self.assertTrue(quad_check["widgetVisible"])
        self.assertEqual(quad_check["metricBoxCount"], 4)
        self.assertEqual(quad_check["qVals"], ["30%", "22%", "26%", "22%"])
        self.assertGreater(quad_check["cx"], 80.0)  # meanRoll +0.6 -> right of center
        self.assertGreater(quad_check["cy"], 80.0)  # meanPitch -0.5 -> below center
        self.assertTrue(quad_check["scrollFits"])
        self.assertEqual(quad_check["overflows"], [])
        self.assert_no_letter_stacking()

        # Switch to Dynamic Balance protocol (2D Span & 4-Quadrant Symmetry)
        pills.nth(2).click()
        expect(self.page.locator("#summaryStartAmp")).to_have_text("14.0°")
        expect(self.page.locator("#summaryCurrentAmp")).to_have_text("28.0°")
        expect(self.page.locator("#summaryAvgSmooth")).to_have_text("100%")
        expect(self.page.locator("#summaryProgressBadge")).to_have_class("progress-badge")
        expect(self.page.locator("#summaryProgressBadge")).to_contain_text("+14.0° (+100%)")
        expect(self.page.locator("#targetNormInput")).to_have_value("25")
        self.assertEqual(
            self.page.evaluate("ui.doctorChart.data.datasets[0].data.map(p => [Math.round(p.x), p.y])"),
            [[73, 14], [100, 28]],
        )

        # Switching back to Wrist hides Quadrant widget and restores Wrist norm
        pills.nth(0).click()
        expect(self.page.locator("#balanceQuadrantWidget")).to_be_hidden()
        expect(self.page.locator("#targetNormInput")).to_have_value("90")

        # Export client CSV: verify UTF-8 BOM + 23-column longitudinal superset across all 6 patient sessions
        with self.page.expect_download() as download_info:
            self.page.locator("#btnDownloadClientCSV").click()
        raw_bytes = download_info.value.path().read_bytes()
        self.assertTrue(raw_bytes.startswith(b"\xef\xbb\xbf"))
        lines = raw_bytes.decode("utf-8-sig").splitlines()
        self.assertEqual(len(lines), 7)  # 1 header + 6 sessions across all 3 protocols
        header_cols = lines[0].split(",")
        self.assertEqual(len(header_cols), 23)
        self.assertEqual(header_cols[9], "Протокол")
        self.assertEqual(header_cols[22], "Симетрія квадрантів (%)")
        wrist_row_cols = lines[1].split(",")
        self.assertEqual(len(wrist_row_cols), 23)
        self.assertEqual(wrist_row_cols[9], '"Кисть (2 напрямки)"')
        self.assertEqual(wrist_row_cols[10:], [""] * 13)
        dyn_row_cols = lines[6].split(",")
        self.assertEqual(dyn_row_cols[9], '"Баланс: Динаміка"')
        self.assertEqual(dyn_row_cols[22], "100.0")


class WebKitDoctorDashboardTests(DoctorDashboardTests):
    browser_name = "webkit"


if __name__ == "__main__":
    unittest.main()
