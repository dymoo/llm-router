import unittest

from laya_service.decode import confidence_from_probs, decode_answers, softmax


class DecodeTests(unittest.TestCase):
    def test_choice_picks_argmax_and_renormalizes(self) -> None:
        questions = {
            "task": {
                "type": "choice",
                "instructions": "task",
                "criteria": {"chat": None, "coding": None},
            }
        }
        answers = decode_answers(
            questions=questions,
            question_ids=["task"],
            logits=[[0.0, 4.0]],
            act_probs=[[0.9, 0.1]],
            marker_counts=[2],
            temperature=[1.0, 1.0, 1.0],
            temperature_by_options={},
        )
        self.assertEqual(answers["task"]["type"], "choice")
        self.assertEqual(answers["task"]["choice"], "coding")
        self.assertAlmostEqual(sum(answers["task"]["probabilities"].values()), 1.0, places=3)
        self.assertGreater(answers["task"]["confidence"], 0.5)

    def test_score_is_expected_level(self) -> None:
        questions = {
            "len": {
                "type": "score",
                "instructions": "length",
                "criteria": ["short", "medium", "long"],
            }
        }
        answers = decode_answers(
            questions=questions,
            question_ids=["len"],
            logits=[[0.0, 0.0, 0.0]],
            act_probs=[[1.0, 0.0]],
            marker_counts=[3],
            temperature=[1.0, 1.0, 1.0],
            temperature_by_options={},
        )
        self.assertEqual(answers["len"]["type"], "score")
        self.assertAlmostEqual(answers["len"]["score"], 1.0, places=3)

    def test_noul_is_true_mass(self) -> None:
        questions = {"t": {"type": "noul", "instructions": "trivial?", "criteria": None}}
        answers = decode_answers(
            questions=questions,
            question_ids=["t"],
            logits=[[0.0, 0.0]],
            act_probs=[[1.0, 0.0]],
            marker_counts=[2],
            temperature=[1.0, 1.0, 1.0],
            temperature_by_options={},
        )
        self.assertEqual(answers["t"]["type"], "noul")
        self.assertAlmostEqual(answers["t"]["noul"], 0.5, places=3)

    def test_confidence_from_probs_uniform_is_low(self) -> None:
        p = softmax([0.0, 0.0, 0.0, 0.0])
        self.assertLess(confidence_from_probs(p, 4), 0.05)


if __name__ == "__main__":
    unittest.main()
