import base64
import importlib.util
import io
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import server


SAMPLE1 = "患者于透析2小时40分钟突感下肢疼痛，予以回氯化0.9%氯化钠300毫升后缓解"
SAMPLE2 = "患者透析1小时感觉头痛，测血压175的95毫米汞柱，予以硝苯地平片10毫克舌下含服后感头痛缓解"
EXPECTED_CATEGORIES = ["低血压", "高血压", "低血糖", "肌肉痉挛", "疲乏", "瘙痒", "胸闷", "头痛", "头晕", "出汗", "恶心", "发热", "腹痛", "腹泻", "呕吐", "皮疹", "气短", "心悸", "腰背痛"]


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = "http://127.0.0.1:" + str(cls.httpd.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def request(self, path, data=None, content_type="application/json", headers=None):
        request = urllib.request.Request(self.url + path, data=data, headers={"Content-Type": content_type, **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    def json_request(self, path, value, headers=None):
        return self.request(path, json.dumps(value, ensure_ascii=False).encode(), headers=headers)

    def test_health_and_origin(self):
        self.assertEqual(self.request("/api/health"), (200, {"status": "ok"}))
        self.assertEqual(self.request("/api/health", headers={"Origin": "https://example.com"})[0], 403)
        self.assertEqual(self.request("/api/health", headers={"Host": "evil.example:" + str(self.httpd.server_port)})[0], 403)

    def test_rules_and_validation(self):
        status, result = self.json_request("/api/classify", {"text": "透析时感到不适"})
        self.assertEqual((status, result["categories"], result["review"], result["mode"]), (200, [], True, "rule"))
        status, result = self.json_request("/api/classify", {"text": "头痛，血压175/95 mmHg"})
        self.assertEqual((status, result["categories"]), (200, ["高血压", "头痛"]))
        self.assertEqual(self.json_request("/api/classify", {"text": "无匹配", "categories": [{"name": "甲"}, {"name": "乙"}]})[1]["categories"], [])
        self.assertEqual(self.json_request("/api/classify", {"text": "", "mode": "rule"})[0], 400)
        self.assertEqual(self.json_request("/api/classify", {"text": "测试", "categories": ["重复", "重复"]})[0], 400)
        self.assertEqual(self.json_request("/api/classify", {"text": "测试", "mode": "bad"})[0], 400)

    def test_negations_and_uncertainty(self):
        for text in ("无头痛、肌肉痉挛", "未出现头痛和肌肉痉挛", "否认头痛和高血压", "头痛阴性", "疑似头痛", "既往头痛"):
            with self.subTest(text=text):
                self.assertEqual(self.json_request("/api/classify", {"text": text})[1]["categories"], [])
        result = self.json_request("/api/classify", {"text": "无头痛，但出现肌肉痉挛"})[1]
        self.assertEqual(result["categories"], ["肌肉痉挛"])
        self.assertEqual(self.json_request("/api/classify", {"text": "目标血压175/95"})[1]["categories"], [])

    def test_nineteen_custom_categories(self):
        categories = ["症状" + str(index).zfill(2) for index in range(19)]
        result = self.json_request("/api/classify", {"text": "症状00、症状18", "categories": categories})[1]
        self.assertEqual(result["categories"], ["症状00", "症状18"])

    def test_default_categories_and_samples(self):
        self.assertEqual([item["name"] for item in server.DEFAULT_CATEGORIES], EXPECTED_CATEGORIES)
        for text, expected in [(SAMPLE1, []), (SAMPLE2, ["高血压", "头痛"]), ("头晕M出汗", ["头晕", "出汗"])]:
            with self.subTest(text=text):
                status, result = self.json_request("/api/classify", {"text": text})
                self.assertEqual((status, result["categories"], result["review"]), (200, expected, True))

    def test_each_default_category(self):
        for category in EXPECTED_CATEGORIES:
            with self.subTest(category=category):
                result = self.json_request("/api/classify", {"text": "出现" + category})[1]
                self.assertIn(category, result["categories"])
                result = self.json_request("/api/classify", {"text": "无" + category})[1]
                self.assertNotIn(category, result["categories"])

    def test_csv_base64_and_gb18030(self):
        content = "姓名,小结\r\n张三,内瘘正常\r\n".encode("gb18030")
        status, result = self.json_request("/api/import", {"filename": "x.csv", "content_base64": base64.b64encode(content).decode()})
        self.assertEqual(status, 200)
        self.assertEqual(result, {"columns": ["姓名", "小结"], "rows": [{"姓名": "张三", "小结": "内瘘正常"}], "count": 1})

    def test_multipart(self):
        body = b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\na,b\r\n1,2\r\n\r\n--boundary--\r\n'
        status, result = self.request("/api/import", body, "multipart/form-data; boundary=boundary")
        self.assertEqual((status, result["rows"]), (200, [{"a": "1", "b": "2"}]))

    def test_import_errors(self):
        for filename, content in [("a.csv", b"a,a\n1,2"), ("a.csv", b"a\n1,2"), ("a.xls", b"data")]:
            status, _ = self.json_request("/api/import", {"filename": filename, "content_base64": base64.b64encode(content).decode()})
            self.assertEqual(status, 400)
        status, _ = self.json_request("/api/import", {"filename": "a.xlsx", "content_base64": base64.b64encode(b"invalid").decode()})
        self.assertEqual(status, 400 if importlib.util.find_spec("openpyxl") else 501)
        self.assertEqual(self.json_request("/api/import", {"filename": "a.csv", "content_base64": "!"})[0], 400)

    @unittest.skipUnless(importlib.util.find_spec("openpyxl"), "openpyxl unavailable")
    def test_xlsx(self):
        import openpyxl
        workbook = openpyxl.Workbook()
        workbook.active.append(["姓名", "小结"])
        workbook.active.append(["李四", "正常"])
        content = io.BytesIO()
        workbook.save(content)
        status, result = self.json_request("/api/import", {"filename": "a.xlsx", "content_base64": base64.b64encode(content.getvalue()).decode()})
        self.assertEqual((status, result["rows"][0]["姓名"]), (200, "李四"))

    def test_jev_protocol(self):
        response = {"model": "jev-test", "answers": {"c" + str(index): {"type": "noul", "noul": 0.9 if name in ("头痛", "高血压") else 0.1} for index, name in enumerate(EXPECTED_CATEGORIES)}}
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test", "JEV_MODEL": "typesafe/jev-1.14"}), patch.object(server, "post_json", return_value=response) as call:
            status, result = self.json_request("/api/classify", {"mode": "jev", "text": "头痛，血压175/95，无肌肉痉挛"})
        self.assertEqual((status, result["categories"], result["review"]), (200, ["高血压", "头痛"], True))
        args = call.call_args.args
        self.assertEqual(args[0], "https://openrouter.ai/api/alpha/decisions")
        self.assertEqual(args[1]["model"], "typesafe/jev-1.14")
        self.assertEqual(len(args[1]["questions"]), 19)
        self.assertTrue(all(question["type"] == "noul" for question in args[1]["questions"].values()))
        self.assertEqual(args[2], "test")

    def test_jev_nineteen_default_model(self):
        categories = ["症状" + str(index).zfill(2) for index in range(19)]
        response = {"answers": {"c" + str(index): {"type": "noul", "noul": 0.9 if index in (0, 18) else 0.1} for index in range(19)}}
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test"}), patch.object(server, "post_json", return_value=response) as call:
            with patch.dict(os.environ):
                os.environ.pop("JEV_MODEL", None)
                status, result = self.json_request("/api/classify", {"mode": "jev", "text": "症状00、症状18", "categories": categories})
        self.assertEqual((status, result["categories"]), (200, ["症状00", "症状18"]))
        self.assertEqual(len(call.call_args.args[1]["questions"]), 19)
        self.assertEqual(call.call_args.args[1]["model"], "typesafe/jev-1.14")

    def test_local_protocol(self):
        response = {"model": "local-test", "choices": [{"message": {"content": '["头痛", "高血压"]'}}]}
        with patch.dict(os.environ, {"LOCAL_MODEL_BASE_URL": "http://127.0.0.1:1234/v1"}), patch.object(server, "post_json", return_value=response) as call:
            status, result = self.json_request("/api/classify", {"mode": "local", "text": "头痛，血压175/95，无肌肉痉挛"})
        self.assertEqual((status, result["categories"]), (200, ["头痛", "高血压"]))
        self.assertEqual(call.call_args.args[0], "http://127.0.0.1:1234/v1/chat/completions")
        self.assertEqual(call.call_args.args[1]["messages"][1]["content"], "头痛，血压175/95，无肌肉痉挛")

    def test_model_semantic_output_not_keyword_filtered(self):
        response = {"model": "local-test", "choices": [{"message": {"content": '["瘙痒"]'}}]}
        with patch.object(server, "post_json", return_value=response):
            status, result = self.json_request("/api/classify", {"mode": "local", "text": "皮肤发痒"})
        self.assertEqual((status, result["categories"], result["review"]), (200, ["瘙痒"], True))
        answers = {"c" + str(index): {"type": "noul", "noul": 0.9 if name == "瘙痒" else 0.1} for index, name in enumerate(EXPECTED_CATEGORIES)}
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test"}), patch.object(server, "post_json", return_value={"answers": answers}):
            status, result = self.json_request("/api/classify", {"mode": "jev", "text": "皮肤发痒"})
        self.assertEqual((status, result["categories"], result["review"]), (200, ["瘙痒"], True))

    def test_model_output_requires_review_even_if_negated(self):
        response = {"choices": [{"message": {"content": '["头痛"]'}}]}
        with patch.object(server, "post_json", return_value=response):
            status, result = self.json_request("/api/classify", {"mode": "local", "text": "否认头痛"})
        self.assertEqual((status, result["categories"], result["review"]), (200, ["头痛"], True))

    def test_local_real_http(self):
        received = {}

        class ModelHandler(server.BaseHTTPRequestHandler):
            def do_POST(self):
                received["path"] = self.path
                received["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received["authorization"] = self.headers.get("Authorization")
                body = json.dumps({"choices": [{"message": {"content": '["甲"]'}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass

        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {"LOCAL_MODEL_BASE_URL": "http://127.0.0.1:" + str(httpd.server_port) + "/v1", "LOCAL_MODEL_API_KEY": "local-test"}):
                status, result = self.json_request("/api/classify", {"mode": "local", "text": "甲", "categories": ["甲", "乙"]})
            self.assertEqual((status, result["categories"]), (200, ["甲"]))
            self.assertEqual(received["path"], "/v1/chat/completions")
            self.assertEqual(received["authorization"], "Bearer local-test")
            self.assertEqual(received["body"]["messages"][1]["content"], "甲")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()

    def test_upstream_failures(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": ""}):
            self.assertEqual(self.json_request("/api/classify", {"mode": "jev", "text": "测试"})[0], 503)
        with patch.dict(os.environ, {"LOCAL_MODEL_BASE_URL": "http://example.com/v1"}):
            self.assertEqual(self.json_request("/api/classify", {"mode": "local", "text": "测试"})[0], 503)
        with patch.dict(os.environ, {"LOCAL_MODEL_BASE_URL": "http://127.0.0.1:1234/v1"}), patch.object(server, "post_json", return_value={"choices": [{"message": {"content": "错误类别"}}]}):
            self.assertEqual(self.json_request("/api/classify", {"mode": "local", "text": "测试"})[0], 502)
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test"}), patch.object(server, "post_json", return_value={"answers": {"category": {"type": "choice", "choice": "c9"}}}):
            self.assertEqual(self.json_request("/api/classify", {"mode": "jev", "text": "测试"})[0], 502)
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test"}), patch.object(server, "post_json", return_value={"answers": {"c0": {"type": "noul", "noul": float("nan")}}}):
            self.assertEqual(self.json_request("/api/classify", {"mode": "jev", "text": "测试"})[0], 502)
        for content in ('["头痛", "头痛"]', '["不存在"]', '{"categories": []}'):
            with self.subTest(content=content), patch.object(server, "post_json", return_value={"choices": [{"message": {"content": content}}]}):
                self.assertEqual(self.json_request("/api/classify", {"mode": "local", "text": "头痛"})[0], 502)


if __name__ == "__main__":
    unittest.main()
