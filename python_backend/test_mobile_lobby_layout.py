"""Guard the lobby's mobile-only overflow and container sizing rules."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MobileLobbyLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        css = (ROOT / "public/style.css").read_text(encoding="utf-8")
        start = css.index("@media (max-width:820px)")
        end = css.index("/* 横屏手机 / 小平板 */", start)
        cls.mobile_css = css[start:end]

    def test_lobby_only_disables_horizontal_scroll(self):
        self.assertIn(
            "#screen-lobby.active{overflow-x:hidden;overflow-y:auto}",
            self.mobile_css,
        )
        self.assertNotIn("touch-action:none", self.mobile_css)

    def test_panel_fits_available_width_including_safe_area(self):
        self.assertIn(
            "#screen-lobby .wide-panel{width:100%;max-width:100%;min-width:0;flex-shrink:0}",
            self.mobile_css,
        )
        self.assertNotIn("#screen-lobby .wide-panel{width:calc(100vw", self.mobile_css)

    def test_nested_content_can_shrink_and_wrap(self):
        self.assertIn("grid-template-columns:minmax(0,1fr)", self.mobile_css)
        self.assertIn("#screen-lobby .lobby-box,#screen-lobby .room-cfg{min-width:0}", self.mobile_css)
        self.assertIn("#screen-lobby .room-item{flex-wrap:wrap;gap:8px;overflow-wrap:anywhere}", self.mobile_css)
        self.assertIn("minmax(min(180px,100%),1fr)", self.mobile_css)

    def test_lobby_buttons_scroll_with_content(self):
        self.assertIn(
            "#screen-lobby .btn-row{position:static;bottom:auto;background:transparent}",
            self.mobile_css,
        )
        # Other screens keep their mobile sticky action rows.
        self.assertIn(".btn-row{position:sticky;bottom:0;", self.mobile_css)


if __name__ == "__main__":
    unittest.main()
