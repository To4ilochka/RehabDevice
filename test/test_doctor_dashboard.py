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
                delete_button.first.scroll_into_view_if_needed()
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
                self.assertEqual(self.page.locator("#chartWrapperContainer").bounding_box()["height"], chart_height)
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


class WebKitDoctorDashboardTests(DoctorDashboardTests):
    browser_name = "webkit"


if __name__ == "__main__":
    unittest.main()