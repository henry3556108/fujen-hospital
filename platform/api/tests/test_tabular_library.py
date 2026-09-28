def test_tabular_library_importable():
    from tabular import preprocess
    from tabular.errors import TabularError

    assert len(preprocess.catalogue()) >= 50
    assert TabularError("x").to_dict()["message"] == "x"
