import unittest

from httpx import ASGITransport, AsyncClient

from app import app


class HealthTest(unittest.IsolatedAsyncioTestCase):
    async def test_health(self) -> None:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "ai"})
